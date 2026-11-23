'use strict';
/**
 * End-to-end test of the enforcement path in a real (headless) Chrome/Edge:
 * Guard + injected page agent + CDP bridge + file inspection, against a local
 * fake chat page. The native dialog is replaced by a scripted stub.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { launchBrowser, findBrowser } = require('../src/core/browser');
const { Guard } = require('../src/core/guard');
const { shutdown } = require('../src/core/extract');

const ROOT = path.join(__dirname, '..');
const SAMPLE = (f) => path.join(ROOT, 'samples', f);

const skip = !findBrowser() && 'no Chrome/Edge found';

test('e2e: prompts and uploads are gated in a real browser', { skip, timeout: 180000 }, async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.end(fs.readFileSync(path.join(__dirname, 'fixtures', 'chat.html')));
    if (req.url.startsWith('/samples/')) return res.end(fs.readFileSync(SAMPLE(path.basename(req.url))));
    if (req.url === '/api/conversation') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { received.push(b); res.end('{}'); });
      return undefined;
    }
    res.statusCode = 404; return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const sites = [{
    id: 'fake', name: 'Fake Chat', hosts: ['127.0.0.1'],
    editorSelector: 'textarea', sendSelector: '#send',
    responseCss: '.answer, .answer * { color: rgb(124, 58, 237) !important; }',
    networkPatterns: ['*://127.0.0.1*/api/*'],
  }];

  const decisions = [];
  const asked = [];
  const confirm = async (req) => { asked.push(req); return decisions.shift() || 'cancel'; };

  const { proc, conn, userDataDir } = launchBrowser({ headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'walled-e2e-')) });
  const guard = new Guard({ conn, sites, confirm, ocrCachePath: os.tmpdir() });
  t.after(async () => {
    proc.kill();
    server.close();
    await shutdown();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
  });
  await guard.start();
  const targetId = await guard.open(base);
  const sid = [...guard.sessions].find(([, s]) => s.targetId === targetId)[0];
  const send = (m, p) => conn.send(m, p, sid);
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evaluate(expr)) return true; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('timeout waiting for ' + expr);
  };
  const settle = () => new Promise((r) => setTimeout(r, 600));
  await waitFor('document.readyState === "complete" && !!document.getElementById("prompt")');

  const typeAndEnter = async (text) => {
    await evaluate(`(() => { const p = document.getElementById('prompt'); p.focus(); p.value = ${JSON.stringify(text)}; })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  const setFiles = async (files) => {
    const { root } = await send('DOM.getDocument', {});
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    await send('DOM.setFileInputFiles', { nodeId, files: files.map(SAMPLE) });
  };

  await t.test('clean prompt is sent without a dialog', async () => {
    await typeAndEnter('hello there');
    await waitFor('window.sent.includes("hello there")');
    assert.strictEqual(asked.length, 0);
  });

  await t.test('marker prompt + Cancel is blocked and stays editable', async () => {
    decisions.push('cancel');
    await typeAndEnter('secret WALLED_SENSITIVE plan');
    await settle();
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].kind, 'prompt');
    assert.match(asked[0].text, /WALLED_SENSITIVE/);
    assert.strictEqual(await evaluate('window.sent.length'), 1);
    assert.strictEqual(await evaluate('document.getElementById("prompt").value'), 'secret WALLED_SENSITIVE plan');
    assert.ok(!received.some((b) => b.includes('WALLED_SENSITIVE')), 'nothing reached the server');
  });

  await t.test('retry with send button + Continue submits the original prompt', async () => {
    decisions.push('continue');
    await evaluate('document.getElementById("send").click()');
    await waitFor('window.sent.includes("secret WALLED_SENSITIVE plan")');
    assert.strictEqual(asked.length, 2);
    await settle();
    assert.ok(received.some((b) => b.includes('secret WALLED_SENSITIVE plan')), 'server got the unmodified prompt');
  });

  for (const [name, kind] of [['sensitive-notes.txt', 'text'], ['sensitive-report.pdf', 'pdf'], ['sensitive-screenshot.png', 'image']]) {
    await t.test(`${kind} upload: Cancel blocks, Continue proceeds`, async () => {
      const before = asked.length;
      decisions.push('cancel');
      await setFiles([name]);
      const end = Date.now() + 60000;
      while (asked.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      await settle();
      assert.strictEqual(asked[before].kind, 'file');
      assert.strictEqual(asked[before].files[0].name, name);
      assert.strictEqual(asked[before].files[0].kind, kind);
      assert.ok(!(await evaluate(`window.uploads.includes(${JSON.stringify(name)})`)), 'blocked file not delivered');

      decisions.push('continue');
      await setFiles([name]);
      await waitFor(`window.uploads.includes(${JSON.stringify(name)})`, 60000);
      assert.strictEqual(asked.length, before + 2);
    });
  }

  await t.test('clean files pass without a dialog; Cancel keeps clean files of a mixed selection', async () => {
    const before = asked.length;
    await setFiles(['clean-notes.txt', 'clean-report.pdf']);
    await waitFor('window.uploads.includes("clean-report.pdf")', 60000);
    assert.strictEqual(asked.length, before);
    await evaluate('window.uploads = []');
    decisions.push('cancel');
    await setFiles(['clean-screenshot.png', 'sensitive-notes.txt']);
    await waitFor('window.uploads.includes("clean-screenshot.png")', 60000);
    assert.deepStrictEqual(await evaluate('window.uploads'), ['clean-screenshot.png']);
    assert.strictEqual(asked.length, before + 1);
  });

  await t.test('drag and drop is gated', async () => {
    const before = asked.length;
    decisions.push('cancel');
    const dropExpr = `(async () => {
      const b = await (await fetch('/samples/sensitive-notes.txt')).blob();
      const dt = new DataTransfer(); dt.items.add(new File([b], 'dropped.txt', { type: 'text/plain' }));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`;
    await evaluate(dropExpr);
    const end = Date.now() + 15000;
    while (asked.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await settle();
    assert.strictEqual(asked[before].files[0].name, 'dropped.txt');
    assert.deepStrictEqual(await evaluate('window.dropped'), []);
    decisions.push('continue');
    await evaluate(dropExpr);
    await waitFor('window.dropped.includes("dropped.txt")');
  });

  await t.test('network backstop catches a marker request sent outside the composer', async () => {
    await new Promise((r) => setTimeout(r, 21000)); // let the earlier approval window expire
    const before = asked.length;
    decisions.push('cancel');
    const res = await evaluate(`fetch('/api/conversation', { method: 'POST', body: JSON.stringify({ text: 'direct WALLED_SENSITIVE call' }) }).then(() => 'ok', (e) => 'blocked')`);
    assert.strictEqual(res, 'blocked');
    assert.strictEqual(asked.length, before + 1);
    assert.ok(!received.some((b) => b.includes('direct WALLED_SENSITIVE call')));
  });

  await t.test('AI responses are recoloured', async () => {
    assert.strictEqual(await evaluate('getComputedStyle(document.getElementById("answer-p")).color'), 'rgb(124, 58, 237)');
    await guard.setRecolor(false);
    assert.notStrictEqual(await evaluate('getComputedStyle(document.getElementById("answer-p")).color'), 'rgb(124, 58, 237)');
  });
});
