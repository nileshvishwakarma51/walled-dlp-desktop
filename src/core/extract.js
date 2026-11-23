'use strict';
/**
 * File content inspection: text, PDF (text layer) and images (OCR).
 * Every scanner returns { kind, text } and never throws for bad input;
 * the caller decides what to do with the text.
 */
const path = require('path');

const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'html', 'htm', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'ini', 'conf', 'toml', 'tex', 'rtf']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jpe', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'pbm', 'pgm', 'ppm']);

function ext(name) { return path.extname(name || '').slice(1).toLowerCase(); }

/** Decide how to inspect a file from its magic bytes, MIME type and extension. */
function classify(name, mime, buf) {
  const head = buf.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (ascii.startsWith('GIF8') || ascii.startsWith('BM')) return 'image';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image';
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'image';
  const e = ext(name);
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  if (m.startsWith('image/') || IMAGE_EXT.has(e)) return 'image';
  if (m.startsWith('text/') || TEXT_EXT.has(e) || m === 'application/json') return 'text';
  return looksLikeText(buf) ? 'text' : 'binary';
}

function looksLikeText(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n < 0.05;
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2)); sw.swap16(); return sw.toString('utf16le');
  }
  return buf.toString('utf8');
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfText(buf, maxPages = 200) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const parts = [];
  try {
    const pages = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => it.str || '').join(' '));
      // Join without separators too: some PDFs split words into single glyph runs.
      parts.push(tc.items.map((it) => it.str || '').join(''));
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    if (meta && meta.info) parts.push(Object.values(meta.info).filter((v) => typeof v === 'string').join(' '));
  } finally {
    await doc.destroy();
  }
  return parts.join('\n');
}

let ocrWorker = null;
let ocrQueue = Promise.resolve();
async function getOcrWorker(cachePath) {
  if (ocrWorker) return ocrWorker;
  const { createWorker } = require('tesseract.js');
  // Language data ships with the app (no network download at runtime).
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  ocrWorker = await createWorker('eng', 1, { langPath, cachePath, gzip: true, cacheMethod: cachePath ? 'write' : 'none' });
  return ocrWorker;
}

/** OCR an image. Calls are serialised through one shared worker to bound memory use. */
function ocr(buf, cachePath) {
  const run = ocrQueue.then(async () => {
    const w = await getOcrWorker(cachePath);
    const { data } = await w.recognize(buf);
    return data.text || '';
  });
  ocrQueue = run.catch(() => {});
  return run;
}

async function shutdown() {
  if (ocrWorker) { const w = ocrWorker; ocrWorker = null; await w.terminate().catch(() => {}); }
}

/**
 * Extract inspectable text from a file.
 * @returns {Promise<{kind:string, text:string, ocrText?:string, error?:string}>}
 */
async function extractText(file, opts = {}) {
  const buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || []);
  const kind = classify(file.name, file.type, buf);
  // Raw bytes are always included: catches the marker in uncompressed PDF
  // streams, image metadata (EXIF/PNG tEXt) and unknown text-like formats.
  const raw = buf.toString('latin1');
  try {
    if (kind === 'text') return { kind, text: decodeText(buf) };
    if (kind === 'pdf') return { kind, text: (await pdfText(buf)) + '\n' + raw };
    if (kind === 'image') return { kind, text: raw, ocrText: await ocr(buf, opts.cachePath) };
    return { kind, text: raw };
  } catch (e) {
    return { kind, text: raw, error: e.message };
  }
}

module.exports = { classify, extractText, pdfText, ocr, shutdown };
