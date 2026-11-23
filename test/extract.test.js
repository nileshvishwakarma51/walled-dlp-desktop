'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createDetector } = require('../src/core/detector');
const { inspectFile } = require('../src/core/inspector');
const { classify, shutdown } = require('../src/core/extract');

const d = createDetector('WALLED_SENSITIVE');
const S = (f) => path.join(__dirname, '..', 'samples', f);
const file = (name, type) => ({ name, type, data: fs.readFileSync(S(name)) });

test.after(() => shutdown());

test('classifies by magic bytes before extension', () => {
  assert.strictEqual(classify('x.txt', '', fs.readFileSync(S('sensitive-report.pdf'))), 'pdf');
  assert.strictEqual(classify('x.bin', '', fs.readFileSync(S('clean-screenshot.png'))), 'image');
  assert.strictEqual(classify('notes', '', Buffer.from('plain words')), 'text');
});

test('text files', async () => {
  assert.strictEqual((await inspectFile(file('sensitive-notes.txt', 'text/plain'), d)).flagged, true);
  assert.strictEqual((await inspectFile(file('clean-notes.txt', 'text/plain'), d)).flagged, false);
});

test('UTF-16 text file', async () => {
  const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('label WALLED_SENSITIVE', 'utf16le')]);
  assert.strictEqual((await inspectFile({ name: 'u16.txt', type: 'text/plain', data }, d)).flagged, true);
});

test('PDF text layer (compressed stream, marker not visible in raw bytes)', async () => {
  const raw = fs.readFileSync(S('sensitive-report.pdf')).toString('latin1');
  assert.ok(!raw.includes('WALLED_SENSITIVE'), 'sample must not contain the marker in plain bytes');
  const r = await inspectFile(file('sensitive-report.pdf', 'application/pdf'), d);
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.flagged, true);
  assert.strictEqual((await inspectFile(file('clean-report.pdf', 'application/pdf'), d)).flagged, false);
});

test('images via OCR', { timeout: 120000 }, async () => {
  const r = await inspectFile(file('sensitive-screenshot.png', 'image/png'), d);
  assert.strictEqual(r.kind, 'image');
  assert.strictEqual(r.flagged, true);
  assert.strictEqual((await inspectFile(file('clean-screenshot.png', 'image/png'), d)).flagged, false);
});

test('corrupt PDF does not throw and falls back to raw bytes', async () => {
  const r = await inspectFile({ name: 'bad.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 garbage WALLED_SENSITIVE') }, d);
  assert.strictEqual(r.flagged, true);
});
