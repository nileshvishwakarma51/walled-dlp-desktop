'use strict';
/**
 * The enforcement engine. Attaches to every page of the controlled browser
 * over CDP, injects the page agent, answers its requests (inspect files, ask
 * the user) and runs a network-level backstop for prompt requests.
 *
 * It is UI-agnostic: the confirmation dialog is passed in as `confirm`, so the
 * Electron app supplies a native dialog and the tests supply a stub.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createDetector } = require('./detector');
const { inspectFiles, MAX_BYTES } = require('./inspector');
const { siteForUrl } = require('./sites');
const { pageAgent } = require('../inject/pageAgent');

const APPROVAL_WINDOW_MS = 20000;

class Guard extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./cdp').CDPConnection} o.conn
   * @param {Array} o.sites           site configs (see sites.js)
   * @param {(req:object)=>Promise<'continue'|'cancel'>} o.confirm  user decision
   * @param {string} [o.marker]
   * @param {boolean} [o.recolor]
   * @param {string} [o.ocrCachePath]
   */
  constructor({ conn, sites, confirm, marker = 'WALLED_SENSITIVE', recolor = true, ocrCachePath, networkBackstop = true }) {
    super();
    this.conn = conn;
    this.sites = sites;
    this.confirmImpl = confirm;
    this.detector = createDetector(marker);
    this.marker = marker;
    this.recolor = recolor;
    this.ocrCachePath = ocrCachePath;
    this.networkBackstop = networkBackstop;
    this.binding = '__w' + crypto.randomBytes(6).toString('hex');
    this.resolver = '__w' + crypto.randomBytes(6).toString('hex');
    this.sessions = new Map(); // sessionId -> { targetId, approvedUntil }
    this.attaching = new Map(); // targetId -> Promise<sessionId>
    this.dialogChain = Promise.resolve();
    this.script = this._buildScript();
  }

  _buildScript() {
    const cfg = {
      binding: this.binding,
      resolver: this.resolver,
      marker: this.marker,
      recolor: this.recolor,
      maxBytes: MAX_BYTES,
      sites: this.sites.map((s) => ({ id: s.id, hosts: s.hosts, editorSelector: s.editorSelector, sendSelector: s.sendSelector, responseCss: s.responseCss })),
    };
    return `(${pageAgent.toString()})(${JSON.stringify(cfg)}, ${require('./detector').createDetector.toString()});`;
  }

  log(evt) {
    this.emit('event', Object.assign({ time: new Date().toISOString() }, evt));
  }

  async start() {
    this.conn.on('event', (method, params, sessionId) => {
      this._onEvent(method, params, sessionId).catch((e) => this.log({ type: 'error', message: e.message }));
    });
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.conn.send('Target.getTargets');
    await Promise.all(targetInfos.filter((t) => t.type === 'page').map((t) => this._attach(t)));
  }

  /** Open a URL in a new tab, guaranteeing the agent is installed before the page loads. */
  async open(url) {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await this._attach({ targetId, type: 'page', url: 'about:blank' });
    if (sessionId) await this.conn.send('Page.navigate', { url }, sessionId);
    return targetId;
  }

  /** Close the empty start-up tab once the real tabs are open. */
  async closeBlankTabs() {
    const { targetInfos } = await this.conn.send('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && !isInternal(t.url));
    const blanks = pages.filter((t) => t.url === 'about:blank');
    if (blanks.length < pages.length) {
      await Promise.all(blanks.map((t) => this.conn.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})));
    }
  }

  _attach(info) {
    if (isInternal(info.url)) return Promise.resolve(null);
    // One attach per target, shared by concurrent callers (targetCreated + open()).
    if (!this.attaching.has(info.targetId)) {
      const p = this._doAttach(info);
      this.attaching.set(info.targetId, p);
    }
    return this.attaching.get(info.targetId);
  }

  async _doAttach(info) {
    try {
      const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      this.sessions.set(sessionId, { targetId: info.targetId, approvedUntil: 0 });
      const s = (m, p) => this.conn.send(m, p, sessionId);
      await s('Runtime.enable');
      await s('Runtime.addBinding', { name: this.binding });
      await s('Page.enable');
      await s('Page.addScriptToEvaluateOnNewDocument', { source: this.script, runImmediately: true });
      if (this.networkBackstop) {
        const patterns = this.sites.flatMap((site) => (site.networkPatterns || []).map((urlPattern) => ({ urlPattern, requestStage: 'Request' })));
        if (patterns.length) await s('Fetch.enable', { patterns });
      }
      await s('Runtime.runIfWaitingForDebugger').catch(() => {});
      // A page that was already showing a monitored site before we attached:
      // make sure the agent is live in it (runImmediately covers most cases).
      if (siteForUrl(this.sites, info.url)) await this._ensureAgent(sessionId);
      return sessionId;
    } catch (e) {
      this.log({ type: 'error', message: `attach failed: ${e.message}` });
      this.attaching.delete(info.targetId);
      return null;
    }
  }

  async _ensureAgent(sessionId) {
    const { result } = await this.conn.send('Runtime.evaluate', { expression: `!!window[${JSON.stringify('__walledAgent_' + this.binding)}]`, returnByValue: true }, sessionId).catch(() => ({ result: {} }));
    if (!result.value) await this.conn.send('Page.reload', {}, sessionId).catch(() => {});
  }

  async _onEvent(method, params, sessionId) {
    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        // targetInfoChanged covers a new-tab page (not monitored) navigating to a site.
        if (params.targetInfo.type === 'page') await this._attach(params.targetInfo);
        break;
      case 'Target.detachedFromTarget':
        if (this.sessions.has(params.sessionId)) this.attaching.delete(this.sessions.get(params.sessionId).targetId);
        this.sessions.delete(params.sessionId);
        break;
      case 'Runtime.bindingCalled':
        if (params.name === this.binding) await this._onAgentMessage(params, sessionId);
        break;
      case 'Fetch.requestPaused':
        await this._onRequestPaused(params, sessionId);
        break;
      default:
    }
  }

  async _reply(sessionId, contextId, id, result) {
    const expression = `window[${JSON.stringify(this.resolver)}](${JSON.stringify(id)}, ${JSON.stringify(result)})`;
    await this.conn.send('Runtime.evaluate', { expression, contextId }, sessionId).catch(() => {});
  }

  /**
   * Serialise dialogs so the user only ever sees one at a time, and give the
   * browser tab focus back afterwards so the user can keep typing.
   */
  confirm(req, sessionId) {
    const run = this.dialogChain.then(() => this.confirmImpl(req)).finally(() => {
      if (sessionId) this.conn.send('Page.bringToFront', {}, sessionId).catch(() => {});
    });
    this.dialogChain = run.catch(() => {});
    return run.then((d) => (d === 'continue' ? 'continue' : 'cancel'), () => 'cancel');
  }

  siteName(id) { const s = this.sites.find((x) => x.id === id); return s ? s.name : id; }

  async _onAgentMessage(params, sessionId) {
    let msg;
    try { msg = JSON.parse(params.payload); } catch { return; }
    const contextId = params.executionContextId;
    const sess = this.sessions.get(sessionId) || { approvedUntil: 0 };
    const site = this.siteName(msg.site);

    if (msg.type === 'prompt') {
      // The agent only asks when it already saw the marker; re-check here so a
      // page script cannot make us show misleading dialogs.
      if (!this.detector.inText(msg.text)) return this._reply(sessionId, contextId, msg.id, { decision: 'allow' });
      const decision = await this.confirm({ kind: 'prompt', site, text: msg.text }, sessionId);
      if (decision === 'continue') sess.approvedUntil = Date.now() + APPROVAL_WINDOW_MS;
      this.log({ type: 'prompt', site, detail: preview(msg.text), decision });
      return this._reply(sessionId, contextId, msg.id, { decision });
    }

    if (msg.type === 'files') {
      const files = (msg.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size, truncated: f.truncated, data: Buffer.from(f.b64 || '', 'base64') }));
      const results = await inspectFiles(files, this.detector, { cachePath: this.ocrCachePath });
      const flagged = results.map((r, i) => (r.flagged ? i : -1)).filter((i) => i >= 0);
      for (const r of results) if (!r.flagged) this.log({ type: 'file', site, detail: `${r.name} (${r.kind}, ${r.ms} ms)`, decision: 'clean' });
      if (!flagged.length) return this._reply(sessionId, contextId, msg.id, { decision: 'allow' });
      const decision = await this.confirm({ kind: 'file', site, source: msg.source, files: flagged.map((i) => results[i]) }, sessionId);
      for (const i of flagged) this.log({ type: 'file', site, detail: `${results[i].name} (${results[i].kind})`, decision });
      if (decision === 'continue') sess.approvedUntil = Date.now() + APPROVAL_WINDOW_MS;
      return this._reply(sessionId, contextId, msg.id, { decision, blocked: decision === 'cancel' ? flagged : [] });
    }

    if (msg.type === 'pressEnter') {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await this.conn.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r' }, key), sessionId).catch(() => {});
      await this.conn.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key), sessionId).catch(() => {});
      return this._reply(sessionId, contextId, msg.id, { decision: 'done' });
    }
    return undefined;
  }

  /**
   * Network backstop: a prompt request that carries the marker but was not
   * approved in the page a moment ago (e.g. sent through a UI path the agent
   * does not know) is held here until the user decides.
   */
  async _onRequestPaused(params, sessionId) {
    const { requestId, request } = params;
    const cont = () => this.conn.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    const sess = this.sessions.get(sessionId) || { approvedUntil: 0 };
    if (request.method !== 'POST') return cont();
    const body = requestBody(request);
    if (!body || !(this.detector.inText(body) || this.detector.inText(safeDecode(body)))) return cont();
    if (Date.now() < sess.approvedUntil) return cont();
    const site = this.siteName((siteForUrl(this.sites, request.url) || {}).id);
    const decision = await this.confirm({ kind: 'prompt', site, text: extractPromptish(body, this.marker), via: 'network' }, sessionId);
    this.log({ type: 'network', site, detail: new URL(request.url).pathname, decision });
    if (decision === 'continue') { sess.approvedUntil = Date.now() + APPROVAL_WINDOW_MS; return cont(); }
    return this.conn.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
  }

  /** Toggle response recolouring in every attached page. */
  async setRecolor(on) {
    this.recolor = !!on;
    this.script = this._buildScript();
    const expression = `window[${JSON.stringify(this.resolver)}] && window[${JSON.stringify(this.resolver)}]('style', ${this.recolor})`;
    await Promise.all([...this.sessions.keys()].map((sid) => this.conn.send('Runtime.evaluate', { expression }, sid).catch(() => {})));
  }
}

/** Browser UI pages (omnibox popup, new-tab page, extensions) are never monitored. */
function isInternal(url) {
  return /^(chrome|chrome-untrusted|edge|devtools|chrome-extension|extension):/i.test(url || '');
}

function requestBody(request) {
  if (request.postData) return request.postData;
  if (Array.isArray(request.postDataEntries)) {
    return request.postDataEntries.map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : '')).join('');
  }
  return '';
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function extractPromptish(body, marker) {
  const text = safeDecode(body);
  const i = text.toUpperCase().indexOf(String(marker).toUpperCase());
  return i < 0 ? text.slice(0, 200) : text.slice(Math.max(0, i - 120), i + 120);
}

function preview(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '...' : t;
}

module.exports = { Guard, preview };
