'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createDetector } = require('../src/core/detector');

const d = createDetector('WALLED_SENSITIVE');

test('exact marker is detected in prompts', () => {
  assert.ok(d.inText('please summarise WALLED_SENSITIVE data'));
  assert.ok(d.inText('WALLED_SENSITIVE'));
  assert.ok(d.inText('line1\nfoo WALLED_SENSITIVE\nbar'));
});

test('case-insensitive and ignores zero-width characters', () => {
  assert.ok(d.inText('walled_sensitive'));
  assert.ok(d.inText('WALLED​_SENSITIVE'));
  assert.ok(d.inText('ＷＡＬＬＥＤ＿ＳＥＮＳＩＴＩＶＥ')); // full-width, NFKC-normalised
});

test('clean prompts are not flagged', () => {
  for (const t of ['', null, undefined, 'hello world', 'WALLED SENSITIVE', 'WALLED_SENSITIV', 'sensitive walled']) {
    assert.strictEqual(d.inText(t), false, String(t));
  }
});

test('OCR matching tolerates separators and look-alike characters', () => {
  assert.ok(d.inOcrText('Tag: WALLED SENSITIVE'));
  assert.ok(d.inOcrText('Tag: WALLED-SENSITIVE'));
  assert.ok(d.inOcrText('Tag: WALLEDSENSITIVE'));
  assert.ok(d.inOcrText('Tag: WA1LED_5ENSITIVE'));
  assert.ok(d.inOcrText('Tag: WALLED_SENSITlVE'));
  assert.ok(d.inOcrText('Tag: WALLE D_SENS ITIVE'));
});

test('OCR matching does not flag unrelated text', () => {
  assert.strictEqual(d.inOcrText('Team lunch menu\nPizza and salad on Friday'), false);
  assert.strictEqual(d.inOcrText('Walled garden, sensitive plants'), false);
  assert.strictEqual(d.inOcrText(''), false);
});

test('detector is self-contained so it can be injected into pages', () => {
  // eslint-disable-next-line no-new-func
  const rebuilt = new Function(`return (${createDetector.toString()})`)()('WALLED_SENSITIVE');
  assert.ok(rebuilt.inText('x WALLED_SENSITIVE y'));
  assert.ok(rebuilt.inOcrText('WALLED SENS1TIVE'));
});
