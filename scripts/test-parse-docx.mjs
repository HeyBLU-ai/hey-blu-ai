#!/usr/bin/env node
/**
 * scripts/test-parse-docx.mjs
 *
 * Tests the DOCX extraction path in lib/ingest/parse-source.mjs.
 *
 * Strategy:
 *   The docs/ directory already contains a real league DOCX file.  We use it
 *   as a known-good integration fixture.  If the file is absent the test falls
 *   back to a synthetic minimal DOCX built from raw ZIP bytes so the test
 *   suite can always run in CI without external files.
 *
 * Assertions:
 *   1. parseSource({ buffer, mimeType: DOCX_MIME }) resolves without throwing.
 *   2. Returns a non-empty array.
 *   3. Each span has:  seq (number ≥ 0), text (non-empty string), page (1).
 *   4. charStart < charEnd.
 *   5. Spans are ordered by seq (0, 1, 2, …).
 *   6. At least one span's text is ≥ 20 characters.
 *   7. filePath with .docx extension routes to DOCX parser (mime inferred).
 *   8. parseSource() with no args still throws (regression).
 */

import { existsSync }        from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join }              from 'node:path';
import { tmpdir, platform }  from 'node:os';
import { fileURLToPath }     from 'node:url';
import { createRequire }     from 'node:module';
import { parseSource }       from '../lib/ingest/parse-source.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOCX builder
//
// A DOCX file is a ZIP archive.  The minimum viable structure that mammoth
// can parse has three entries:
//   [Content_Types].xml
//   _rels/.rels
//   word/document.xml
//
// We build the ZIP using Node's built-in zlib + a hand-rolled ZIP writer so
// there is no extra dependency.
// ─────────────────────────────────────────────────────────────────────────────

import { deflateRawSync } from 'node:zlib';

/**
 * Compute CRC-32 of a Buffer.
 * Using a pre-computed table for the standard polynomial 0xEDB88320.
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/**
 * Write a single local-file entry into a ZIP and return the central-directory
 * record for it.
 *
 * @param {Buffer}   fileData      - Raw (uncompressed) file bytes.
 * @param {string}   name          - ZIP entry path.
 * @param {Buffer[]} out           - Accumulator for the ZIP output bytes.
 * @returns {{ cdRecord: Buffer, localOffset: number }}
 */
function addZipEntry(fileData, name, out) {
  const nameBytes   = Buffer.from(name, 'utf8');
  const compressed  = deflateRawSync(fileData);
  const crc         = crc32(fileData);
  const localOffset = out.reduce((s, b) => s + b.length, 0);

  // Local file header
  const localHeader = Buffer.allocUnsafe(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034B50, 0);  // signature
  localHeader.writeUInt16LE(20, 4);           // version needed
  localHeader.writeUInt16LE(0, 6);            // flags
  localHeader.writeUInt16LE(8, 8);            // compression (deflate)
  localHeader.writeUInt16LE(0, 10);           // mod time
  localHeader.writeUInt16LE(0, 12);           // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(fileData.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);           // extra field length
  nameBytes.copy(localHeader, 30);

  out.push(localHeader, compressed);

  // Central directory record
  const cdRecord = Buffer.allocUnsafe(46 + nameBytes.length);
  cdRecord.writeUInt32LE(0x02014B50, 0);  // signature
  cdRecord.writeUInt16LE(20, 4);           // version made by
  cdRecord.writeUInt16LE(20, 6);           // version needed
  cdRecord.writeUInt16LE(0, 8);            // flags
  cdRecord.writeUInt16LE(8, 10);           // compression
  cdRecord.writeUInt16LE(0, 12);           // mod time
  cdRecord.writeUInt16LE(0, 14);           // mod date
  cdRecord.writeUInt32LE(crc, 16);
  cdRecord.writeUInt32LE(compressed.length, 20);
  cdRecord.writeUInt32LE(fileData.length, 24);
  cdRecord.writeUInt16LE(nameBytes.length, 28);
  cdRecord.writeUInt16LE(0, 30);           // extra length
  cdRecord.writeUInt16LE(0, 32);           // comment length
  cdRecord.writeUInt16LE(0, 34);           // disk start
  cdRecord.writeUInt16LE(0, 36);           // internal attrs
  cdRecord.writeUInt32LE(0, 38);           // external attrs
  cdRecord.writeUInt32LE(localOffset, 42); // offset of local header
  nameBytes.copy(cdRecord, 46);

  return { cdRecord };
}

/**
 * Build a minimal but valid DOCX buffer containing two paragraphs.
 *
 * @param {string} para1
 * @param {string} para2
 * @returns {Buffer}
 */
function buildMinimalDocx(para1, para2) {
  function xmlPara(text) {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }

  const contentTypes = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml"  ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
    'utf8',
  );

  const rels = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>',
    'utf8',
  );

  const document = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    xmlPara(para1) +
    '<w:p/>' +   // blank paragraph = paragraph break
    xmlPara(para2) +
    '<w:sectPr/>' +
    '</w:body></w:document>',
    'utf8',
  );

  const out = [];
  const cdRecords = [];

  cdRecords.push(addZipEntry(contentTypes, '[Content_Types].xml', out).cdRecord);
  cdRecords.push(addZipEntry(rels,         '_rels/.rels',         out).cdRecord);
  cdRecords.push(addZipEntry(document,     'word/document.xml',   out).cdRecord);

  const cdOffset = out.reduce((s, b) => s + b.length, 0);
  const cdSize   = cdRecords.reduce((s, b) => s + b.length, 0);

  // End of central directory record
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0,               4);  // disk number
  eocd.writeUInt16LE(0,               6);  // disk with cd
  eocd.writeUInt16LE(cdRecords.length, 8);
  eocd.writeUInt16LE(cdRecords.length, 10);
  eocd.writeUInt32LE(cdSize,          12);
  eocd.writeUInt32LE(cdOffset,        16);
  eocd.writeUInt16LE(0,               20);  // comment length

  return Buffer.concat([...out, ...cdRecords, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function assertSpans(label, spans) {
  check(`${label}: returns array`,         Array.isArray(spans));
  check(`${label}: non-empty`,             spans.length > 0,          `got ${spans.length}`);
  check(`${label}: has long span (≥20ch)`, spans.some(s => s.text.length >= 20));

  const seqs = spans.map(s => s.seq);
  check(`${label}: seq ordered 0,1,2…`,    seqs.every((v, i) => v === i), `seqs: ${seqs}`);

  for (const span of spans) {
    check(`${label}[${span.seq}] seq≥0`,         typeof span.seq  === 'number' && span.seq >= 0);
    check(`${label}[${span.seq}] text non-empty`, typeof span.text === 'string' && span.text.trim().length > 0);
    check(`${label}[${span.seq}] page===1`,       span.page === 1,            `got ${span.page}`);
    check(`${label}[${span.seq}] charStart<charEnd`, span.charStart < span.charEnd,
          `${span.charStart}..${span.charEnd}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n━━━  parse-source DOCX extraction test  ━━━\n');

const PARA1 = 'Rule 505: No-collision rule. A runner must slide or avoid contact with a fielder who has possession of the ball.';
const PARA2 = 'Rule 506: Obstruction. A fielder who does not have possession of the ball and is not in the act of fielding it shall not impede the runner.';

const syntheticDocx = buildMinimalDocx(PARA1, PARA2);
console.log(`Synthetic DOCX size: ${syntheticDocx.length} bytes`);

// ── Test 1: buffer + explicit MIME type ───────────────────────────────────────
console.log('\nTest 1: parseSource({ buffer, mimeType: DOCX_MIME })');
let spans1;
try {
  spans1 = await parseSource({ buffer: syntheticDocx, mimeType: DOCX_MIME });
  check('resolves without throwing', true);
} catch (e) {
  check('resolves without throwing', false, e.message);
  console.error('\nFull error:', e);
  spans1 = null;
}

if (spans1) {
  assertSpans('Test1', spans1);

  const allText = spans1.map(s => s.text).join(' ');
  check('contains Rule 505 text', allText.includes('Rule 505'), `text: "${allText.slice(0, 120)}"`);
  check('contains Rule 506 text', allText.includes('Rule 506'), `text: "${allText.slice(0, 120)}"`);

  console.log(`\n  Spans returned: ${spans1.length}`);
  for (const s of spans1) {
    console.log(`    seq=${s.seq} page=${s.page} chars=${s.charStart}..${s.charEnd} text="${s.text.slice(0, 80)}"`);
  }
}

// ── Test 2: filePath .docx — mime inferred ────────────────────────────────────
console.log('\nTest 2: parseSource({ filePath }) — mime inferred from .docx extension');
const tmpPath = join(tmpdir(), `test-parse-${Date.now()}.docx`);
try {
  await writeFile(tmpPath, syntheticDocx);
  const spans2 = await parseSource({ filePath: tmpPath });
  check('filePath resolves without throwing', true);
  assertSpans('Test2-filePath', spans2);
} catch (e) {
  check('filePath resolves without throwing', false, e.message);
  console.error('\nFull error:', e);
} finally {
  await unlink(tmpPath).catch(() => {});
}

// ── Test 3: real DOCX fixture if present ─────────────────────────────────────
const realDocxPath = join(__dirname, '..', 'docs', 'BLU Certification_  BLU Diamond & BLU Zone.docx');
if (existsSync(realDocxPath)) {
  console.log(`\nTest 3: real DOCX fixture — ${realDocxPath}`);
  try {
    const realSpans = await parseSource({ filePath: realDocxPath });
    check('real DOCX resolves without throwing', true);
    check('real DOCX returns array',             Array.isArray(realSpans));
    check('real DOCX is non-empty',              realSpans.length > 0);
    console.log(`  Spans: ${realSpans.length}, first 80 chars: "${realSpans[0]?.text?.slice(0, 80)}"`);
  } catch (e) {
    check('real DOCX resolves without throwing', false, e.message);
  }
} else {
  console.log('\nTest 3: real DOCX fixture not found — skipped');
}

// ── Test 4: no-args regression ────────────────────────────────────────────────
console.log('\nTest 4: parseSource() with no args still throws (regression)');
try {
  await parseSource();
  check('throws on no args', false, 'did not throw');
} catch (e) {
  check('throws on no args', e instanceof Error && e.message.length > 10,
        `message: "${e.message.slice(0, 80)}"`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
