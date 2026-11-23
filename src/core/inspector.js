'use strict';
/** Turns extracted file text into a verdict. */
const { extractText } = require('./extract');

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * @param {{name:string,type:string,data:Buffer,truncated?:boolean}} file
 * @param {ReturnType<import('./detector').createDetector>} detector
 */
async function inspectFile(file, detector, opts = {}) {
  const started = Date.now();
  const res = await extractText(file, opts);
  const flagged = detector.inText(res.text) || (res.ocrText != null && detector.inOcrText(res.ocrText));
  return {
    name: file.name,
    kind: res.kind,
    size: file.size != null ? file.size : (file.data ? file.data.length : 0),
    flagged,
    truncated: !!file.truncated,
    error: res.error || null,
    ms: Date.now() - started,
  };
}

async function inspectFiles(files, detector, opts) {
  const out = [];
  for (const f of files) out.push(await inspectFile(f, detector, opts));
  return out;
}

module.exports = { inspectFile, inspectFiles, MAX_BYTES };
