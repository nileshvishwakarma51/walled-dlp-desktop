'use strict';
/**
 * The in-page agent. The desktop app injects this function (serialised) into
 * every ChatGPT / Perplexity document through the Chrome DevTools Protocol
 * (Page.addScriptToEvaluateOnNewDocument), so it runs before the web app's
 * own code. It is NOT a browser extension: nothing is installed in the browser.
 *
 * Responsibilities:
 *  - hold back prompt submissions (Enter key, send button, form submit) whose
 *    text contains the marker, until the desktop app returns a decision;
 *  - hold back file selections (file picker, drag and drop, paste,
 *    showOpenFilePicker) and hand the bytes to the desktop app for inspection;
 *  - replay the original action on Continue, drop it on Cancel;
 *  - recolour AI responses with a constructed stylesheet.
 *
 * Communication: `send` is a CDP binding (Runtime.addBinding) that delivers a
 * JSON message to the desktop app; the app answers by calling the resolver
 * function whose random name it chose for this session.
 */
function pageAgent(cfg, createDetector) {
  const guardKey = '__walledAgent_' + cfg.binding;
  if (window[guardKey]) return;
  Object.defineProperty(window, guardKey, { value: true });

  const host = location.hostname;
  const site = cfg.sites.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h)));
  if (!site) return;

  const send = window[cfg.binding];
  try { delete window[cfg.binding]; } catch (e) { /* ignore */ }
  if (typeof send !== 'function') return;

  const det = createDetector(cfg.marker);
  const pending = new Map();
  let seq = 0;
  let sheet = null;

  // ---- bridge -------------------------------------------------------------
  Object.defineProperty(window, cfg.resolver, {
    value: (id, result) => {
      if (id === 'style') { if (sheet) sheet.disabled = !result; return true; }
      const p = pending.get(id);
      if (p) { pending.delete(id); p(result); }
      return true;
    },
  });

  function ask(msg, timeoutMs) {
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => { if (pending.delete(id)) resolve({ decision: 'cancel', reason: 'timeout' }); }, timeoutMs || 10 * 60 * 1000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r || { decision: 'cancel' }); });
      try {
        send(JSON.stringify(Object.assign({ id, site: site.id, url: location.href }, msg)));
      } catch (e) {
        pending.delete(id); clearTimeout(timer); resolve({ decision: 'cancel', reason: 'bridge' });
      }
    });
  }

  function block(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ---- response colouring -------------------------------------------------
  function installStyle() {
    if (!site.responseCss) return;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(site.responseCss);
      sheet.disabled = !cfg.recolor;
      const ensure = () => {
        if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      };
      ensure();
      setInterval(ensure, 1500); // the app may reset adoptedStyleSheets on navigation
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = site.responseCss;
      (document.head || document.documentElement).appendChild(style);
    }
  }
  installStyle();

  // ---- prompt interception -------------------------------------------------
  let promptBusy = false;
  let allowUntil = 0; // after Continue, let the replayed submission through

  function editorText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function visible(el) { return !!(el && (el.offsetParent || el.getClientRects().length)); }

  function findEditor(from) {
    const sel = site.editorSelector;
    let el = from && from.closest ? from.closest(sel) : null;
    if (el) return el;
    const form = from && from.closest ? from.closest('form') : null;
    if (form) { el = [...form.querySelectorAll(sel)].find(visible); if (el) return el; }
    const a = document.activeElement;
    if (a && a.matches && a.matches(sel)) return a;
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }

  function findSendButton(editor) {
    const scope = (editor && editor.closest('form')) || document;
    const btns = [...scope.querySelectorAll(site.sendSelector)].filter(visible);
    return btns.find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true') || btns[0] || null;
  }

  async function gatePrompt(editor, replay) {
    promptBusy = true;
    let r;
    try {
      r = await ask({ type: 'prompt', text: editorText(editor).slice(0, 20000) });
    } finally {
      promptBusy = false;
    }
    if (r.decision === 'continue') {
      allowUntil = Date.now() + 4000;
      await replay();
    } else {
      try { editor.focus(); } catch (e) { /* ignore */ }
    }
  }

  // Replay a submission: click the site's send button, or ask the desktop app
  // to type a trusted Enter key into the focused editor.
  async function replaySubmit(editor, button) {
    try { editor.focus(); } catch (e) { /* ignore */ }
    const btn = (button && button.isConnected) ? button : findSendButton(editor);
    if (btn && !btn.disabled) { btn.click(); return; }
    await ask({ type: 'pressEnter' }, 5000);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest(site.editorSelector)) return;
    if (Date.now() < allowUntil) return;
    if (promptBusy) { block(e); return; }
    const editor = t.closest(site.editorSelector);
    if (!det.inText(editorText(editor))) return; // clean prompt: untouched
    block(e);
    gatePrompt(editor, () => replaySubmit(editor, null));
  }, true);

  function onSendClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest(site.sendSelector) : null;
    if (!btn) return;
    if (Date.now() < allowUntil) return;
    if (promptBusy) { block(e); return; }
    const editor = findEditor(btn);
    if (!editor || !det.inText(editorText(editor))) return;
    block(e);
    if (e.type === 'click') gatePrompt(editor, () => replaySubmit(editor, btn));
  }
  window.addEventListener('click', onSendClick, true);
  // Some UIs submit on pointer/mouse down; hold those back too (click starts the dialog).
  window.addEventListener('pointerdown', onSendClick, true);
  window.addEventListener('mousedown', onSendClick, true);

  window.addEventListener('submit', (e) => {
    if (Date.now() < allowUntil) return;
    const form = e.target;
    const editor = form && form.querySelector ? [...form.querySelectorAll(site.editorSelector)].find((x) => det.inText(editorText(x))) : null;
    if (!editor) return;
    block(e);
    if (promptBusy) return;
    gatePrompt(editor, () => replaySubmit(editor, null));
  }, true);

  // ---- file interception ---------------------------------------------------
  const ours = new WeakSet(); // events we re-dispatch ourselves
  const watchedInputs = new WeakSet();

  async function toPayload(file) {
    const max = cfg.maxBytes;
    const blob = file.size > max ? file.slice(0, max) : file;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { name: file.name, type: file.type, size: file.size, truncated: file.size > max, b64: btoa(bin) };
  }

  /** Inspect files in the desktop app. Resolves to the files allowed to proceed. */
  async function gateFiles(files, source) {
    const payload = [];
    for (const f of files) payload.push(await toPayload(f));
    const r = await ask({ type: 'files', source, files: payload });
    if (r.decision === 'allow' || r.decision === 'continue') return files;
    const blocked = new Set(r.blocked || files.map((_, i) => i));
    return files.filter((_, i) => !blocked.has(i));
  }

  function fileList(files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    return dt;
  }

  function onFileInput(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (ours.has(e)) return;
    e.stopImmediatePropagation();
    if (e.type !== 'change') return; // 'input' fires first; we replay both after inspection
    const files = [...(input.files || [])];
    if (!files.length) return;
    gateFiles(files, 'file picker').then((keep) => {
      if (keep.length !== files.length) input.files = fileList(keep).files;
      if (!keep.length) { input.value = ''; return; }
      for (const type of ['input', 'change']) {
        const ev = new Event(type, { bubbles: true });
        ours.add(ev);
        input.dispatchEvent(ev);
      }
    });
  }
  window.addEventListener('input', onFileInput, true);
  window.addEventListener('change', onFileInput, true);

  // File inputs that are never attached to the document do not propagate
  // events to window, so watch them directly when the app opens them.
  function watchInput(input) {
    if (watchedInputs.has(input)) return;
    watchedInputs.add(input);
    input.addEventListener('input', onFileInput, true);
    input.addEventListener('change', onFileInput, true);
  }
  for (const m of ['click', 'showPicker']) {
    const orig = HTMLInputElement.prototype[m];
    if (typeof orig !== 'function') continue;
    HTMLInputElement.prototype[m] = function () {
      if (this.type === 'file' && !this.isConnected) watchInput(this);
      return orig.apply(this, arguments);
    };
  }

  window.addEventListener('drop', (e) => {
    if (ours.has(e)) return;
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const files = [...dt.files];
    const target = e.target;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    block(e);
    gateFiles(files, 'drag and drop').then((keep) => {
      if (!keep.length) {
        const leave = new DragEvent('dragleave', Object.assign({ dataTransfer: new DataTransfer() }, init));
        ours.add(leave); target.dispatchEvent(leave);
        return;
      }
      const ev = new DragEvent('drop', Object.assign({ dataTransfer: fileList(keep) }, init));
      ours.add(ev);
      target.dispatchEvent(ev);
    });
  }, true);

  window.addEventListener('paste', (e) => {
    if (ours.has(e)) return;
    const cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    const files = [...cd.files];
    const text = cd.getData('text/plain');
    const target = e.target;
    block(e);
    gateFiles(files, 'paste').then((keep) => {
      if (!keep.length) return;
      const dt = fileList(keep);
      if (text) dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
      ours.add(ev);
      target.dispatchEvent(ev);
    });
  }, true);

  if (typeof window.showOpenFilePicker === 'function') {
    const origPicker = window.showOpenFilePicker;
    window.showOpenFilePicker = async function () {
      const handles = await origPicker.apply(this, arguments);
      const files = await Promise.all(handles.map((h) => h.getFile()));
      const keep = await gateFiles(files, 'file picker');
      const kept = handles.filter((_, i) => keep.includes(files[i]));
      if (!kept.length) throw new DOMException('The user aborted a request.', 'AbortError');
      return kept;
    };
  }
}

module.exports = { pageAgent };
