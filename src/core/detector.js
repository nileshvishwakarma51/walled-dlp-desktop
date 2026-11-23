'use strict';
/**
 * Marker detection. Kept dependency-free and self-contained on purpose:
 * `createDetector` is serialised with Function.prototype.toString() and
 * injected into the web pages, so the page and the desktop app use the
 * exact same logic.
 */
function createDetector(marker) {
  const MARKER = String(marker || 'WALLED_SENSITIVE');
  const upper = MARKER.toUpperCase();
  // Letters/digits only, e.g. WALLEDSENSITIVE. Used for noisy OCR text where
  // the underscore is often read as a space, dash or dropped entirely.
  const squashed = upper.replace(/[^A-Z0-9]/g, '');
  const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

  /** Exact (case-insensitive) match for typed text, prompts and text/PDF files. */
  function inText(text) {
    if (text == null) return false;
    const t = String(text).replace(ZERO_WIDTH, '').normalize('NFKC').toUpperCase();
    return t.includes(upper);
  }

  // Characters OCR engines commonly confuse, mapped to the letter the marker uses.
  const OCR_MAP = { '0': 'O', '1': 'I', '|': 'I', '!': 'I', '5': 'S', '$': 'S', '3': 'E', '8': 'B', '4': 'A', '7': 'T' };

  function squash(text) {
    let out = '';
    const t = String(text).normalize('NFKC').toUpperCase();
    for (const ch of t) {
      const c = OCR_MAP[ch] || ch;
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) out += c;
    }
    return out;
  }

  function editDistance(a, b, max) {
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * Tolerant match for OCR output: ignores separators/whitespace, maps common
   * look-alike characters and allows up to `maxEdits` character errors.
   */
  function inOcrText(text, maxEdits) {
    if (inText(text)) return true;
    const s = squash(text || '');
    if (s.includes(squashed)) return true;
    const k = maxEdits == null ? 2 : maxEdits;
    if (k <= 0 || s.length < squashed.length - k) return false;
    const n = squashed.length;
    for (let len = n - k; len <= n + k; len++) {
      for (let i = 0; i + len <= s.length; i++) {
        if (editDistance(s.slice(i, i + len), squashed, k) <= k) return true;
      }
    }
    return false;
  }

  return { marker: MARKER, inText, inOcrText };
}

module.exports = { createDetector };
