'use strict';
/**
 * Generates the demo/test files in samples/.
 *   node scripts/make-samples.js
 * The PDF text stream is Flate-compressed, so the marker is only found by
 * real PDF text extraction, not by a raw byte search. The PNG needs ffmpeg
 * (drawtext) and is committed, so tests do not depend on ffmpeg.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(path.join(out, 'sensitive-notes.txt'), 'Q3 planning notes\nCustomer list attached.\nClassification: WALLED_SENSITIVE\n');
fs.writeFileSync(path.join(out, 'clean-notes.txt'), 'Q3 planning notes\nNothing confidential here.\n');

function pdf(lines) {
  const content = ['BT', '/F1 18 Tf', '72 720 Td', '24 TL']
    .concat(lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`))
    .concat(['ET'])
    .join('\n');
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    let b;
    if (o === null) {
      b = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        stream,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    }
    offsets.push(len);
    parts.push(b);
    len += b.length;
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '].concat(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)).join('\n');
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

fs.writeFileSync(path.join(out, 'sensitive-report.pdf'), pdf(['Quarterly report (draft)', 'Revenue figures for internal review.', 'Label: WALLED_SENSITIVE']));
fs.writeFileSync(path.join(out, 'clean-report.pdf'), pdf(['Quarterly report (public)', 'Nothing confidential here.']));

function png(file, lines) {
  const font = process.platform === 'win32' ? 'C\\:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const draw = lines.map((l, i) => `drawtext=fontfile='${font}':text='${l}':fontcolor=black:fontsize=44:x=60:y=${70 + i * 80}`).join(',');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1000x320', '-vf', draw, '-frames:v', '1', file]);
}

try {
  png(path.join(out, 'sensitive-screenshot.png'), ['Internal dashboard export', 'Tag\\: WALLED_SENSITIVE', 'Do not share outside Walled']);
  png(path.join(out, 'clean-screenshot.png'), ['Team lunch menu', 'Pizza and salad on Friday']);
} catch (e) {
  console.warn('PNG samples skipped (ffmpeg with drawtext not found):', e.message);
}
console.log('samples written to', out);
