#!/usr/bin/env node
/**
 * scripts/test-parse-warnings.mjs
 *
 * Tests the dual-pass compareExtractions() logic in lib/ingest/parse-source.mjs.
 *
 * compareExtractions() is exported so it can be tested directly without going
 * through the full parsePdf / parseDocx pipeline.  This keeps the test fast
 * and free of external dependencies.
 *
 * Assertions:
 *   Test 1 — Large discrepancy (>25%) → ALL primary spans get parse_warnings.
 *   Test 2 — Small discrepancy (<25%) → NO warnings added.
 *   Test 3 — Threshold parameter respected:
 *              same data, threshold=0.90 (very strict) → warns;
 *              same data, threshold=0.10 (very loose) → no warn.
 *   Test 4 — Empty alternate → primary returned unchanged (no crash).
 *   Test 5 — Empty primary → returned unchanged (no crash).
 *   Test 6 — Equal spans → no warnings.
 *   Test 7 — Multiple primary spans all receive the warning message.
 *   Test 8 — Warning message contains primary char count, alternate char count,
 *              and percentage delta.
 *   Test 9 — compareExtractions does NOT mutate the alternate array.
 *   Test 10 — parseSource({ text }) with plain text has no parse_warnings
 *              (text path skips dual-pass).
 *   Test 11 — DOCX round-trip: clean minimal DOCX produces no parse_warnings
 *              (both mammoth passes agree for a simple document).
 */

import { compareExtractions, parseSource } from '../lib/ingest/parse-source.mjs';
import { deflateRawSync }                  from 'node:zlib';

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

/** Build a SourceSpan-shaped object with a given text length. */
function makeSpan(seq, textLength, extra = {}) {
  return {
    seq,
    text:      'x'.repeat(textLength),
    heading:   null,
    page:      1,
    charStart: 0,
    charEnd:   textLength,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOCX builder (reuse from test-parse-docx.mjs)
// ─────────────────────────────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
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

function addZipEntry(fileData, name, out) {
  const nb = Buffer.from(name, 'utf8'), comp = deflateRawSync(fileData), crc = crc32(fileData);
  const lo = out.reduce((s, b) => s + b.length, 0);
  const lh = Buffer.allocUnsafe(30 + nb.length);
  lh.writeUInt32LE(0x04034B50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
  lh.writeUInt16LE(8,8); lh.writeUInt16LE(0,10); lh.writeUInt16LE(0,12);
  lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18); lh.writeUInt32LE(fileData.length,22);
  lh.writeUInt16LE(nb.length,26); lh.writeUInt16LE(0,28); nb.copy(lh,30);
  out.push(lh, comp);
  const cd = Buffer.allocUnsafe(46 + nb.length);
  cd.writeUInt32LE(0x02014B50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
  cd.writeUInt16LE(0,8); cd.writeUInt16LE(8,10); cd.writeUInt16LE(0,12); cd.writeUInt16LE(0,14);
  cd.writeUInt32LE(crc,16); cd.writeUInt32LE(comp.length,20); cd.writeUInt32LE(fileData.length,24);
  cd.writeUInt16LE(nb.length,28); cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32);
  cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38); cd.writeUInt32LE(lo,42);
  nb.copy(cd,46);
  return { cdRecord: cd };
}

function buildMinimalDocx(para1, para2) {
  const p = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const ct = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','utf8');
  const rl = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>','utf8');
  const dc = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+p(para1)+'<w:p/>'+p(para2)+'<w:sectPr/></w:body></w:document>','utf8');
  const out=[],cds=[];
  cds.push(addZipEntry(ct,'[Content_Types].xml',out).cdRecord);
  cds.push(addZipEntry(rl,'_rels/.rels',out).cdRecord);
  cds.push(addZipEntry(dc,'word/document.xml',out).cdRecord);
  const cdOff=out.reduce((s,b)=>s+b.length,0), cdSz=cds.reduce((s,b)=>s+b.length,0);
  const eocd=Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054B50,0);eocd.writeUInt16LE(0,4);eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(cds.length,8);eocd.writeUInt16LE(cds.length,10);
  eocd.writeUInt32LE(cdSz,12);eocd.writeUInt32LE(cdOff,16);eocd.writeUInt16LE(0,20);
  return Buffer.concat([...out,...cds,eocd]);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n━━━  dual-pass compareExtractions test  ━━━\n');

// ── Test 1: Large discrepancy → warnings fired ────────────────────────────────
console.log('Test 1: primary=1000 chars, alternate=100 chars (90% diff > 25% threshold)');
{
  const primary   = [makeSpan(0, 500), makeSpan(1, 500)];
  const alternate = [makeSpan(0, 100)];
  const result    = compareExtractions(primary, alternate);
  check('1a: returns primary array',         result === primary);
  check('1b: span[0] has parse_warnings',    Array.isArray(result[0].parse_warnings) && result[0].parse_warnings.length > 0,
        `got: ${JSON.stringify(result[0].parse_warnings)}`);
  check('1c: span[1] has parse_warnings',    Array.isArray(result[1].parse_warnings) && result[1].parse_warnings.length > 0);
}

// ── Test 2: Small discrepancy → no warnings ───────────────────────────────────
console.log('\nTest 2: primary=1000 chars, alternate=950 chars (5% diff < 25% threshold)');
{
  const primary   = [makeSpan(0, 1000)];
  const alternate = [makeSpan(0, 950)];
  compareExtractions(primary, alternate);
  check('2: no parse_warnings added',        !primary[0].parse_warnings || primary[0].parse_warnings.length === 0,
        `got: ${JSON.stringify(primary[0].parse_warnings)}`);
}

// ── Test 3: Threshold parameter respected ────────────────────────────────────
console.log('\nTest 3: custom thresholds');
{
  const p1 = [makeSpan(0, 1000)];
  const a1 = [makeSpan(0, 820)];  // 18% diff

  compareExtractions(p1, a1, 0.10); // strict (10%) → should warn
  check('3a: threshold=0.10 warns at 18% diff', Array.isArray(p1[0].parse_warnings) && p1[0].parse_warnings.length > 0);

  const p2 = [makeSpan(0, 1000)];
  const a2 = [makeSpan(0, 820)];  // 18% diff
  compareExtractions(p2, a2, 0.30); // loose (30%) → should not warn
  check('3b: threshold=0.30 no warn at 18% diff', !p2[0].parse_warnings || p2[0].parse_warnings.length === 0);
}

// ── Test 4: Empty alternate → no crash, primary unchanged ────────────────────
console.log('\nTest 4: empty alternate array');
{
  const primary = [makeSpan(0, 500)];
  const result  = compareExtractions(primary, []);
  check('4a: returns primary',               result === primary);
  check('4b: no warnings added',             !primary[0].parse_warnings || primary[0].parse_warnings.length === 0);
}

// ── Test 5: Empty primary → no crash ─────────────────────────────────────────
console.log('\nTest 5: empty primary array');
{
  const result = compareExtractions([], [makeSpan(0, 500)]);
  check('5: returns empty array',            Array.isArray(result) && result.length === 0);
}

// ── Test 6: Equal spans → no warnings ────────────────────────────────────────
console.log('\nTest 6: identical character counts');
{
  const primary   = [makeSpan(0, 500), makeSpan(1, 300)];
  const alternate = [makeSpan(0, 800)];
  compareExtractions(primary, alternate);
  check('6: no warnings when equal',         !primary[0].parse_warnings || primary[0].parse_warnings.length === 0);
}

// ── Test 7: All spans receive the warning ────────────────────────────────────
console.log('\nTest 7: all primary spans receive warning (3-span primary)');
{
  const primary   = [makeSpan(0, 300), makeSpan(1, 300), makeSpan(2, 300)];
  const alternate = [makeSpan(0, 50)];
  compareExtractions(primary, alternate);
  check('7a: span[0] warned',                primary[0].parse_warnings?.length > 0);
  check('7b: span[1] warned',                primary[1].parse_warnings?.length > 0);
  check('7c: span[2] warned',                primary[2].parse_warnings?.length > 0);
}

// ── Test 8: Warning message content ─────────────────────────────────────────
console.log('\nTest 8: warning message contains char counts and pct');
{
  const primary   = [makeSpan(0, 1000)];
  const alternate = [makeSpan(0, 100)];
  compareExtractions(primary, alternate);
  const msg = primary[0].parse_warnings?.[0] ?? '';
  check('8a: msg includes primary count',    msg.includes('1000'), `msg: "${msg.slice(0,120)}"`);
  check('8b: msg includes alternate count',  msg.includes('100'),  `msg: "${msg.slice(0,120)}"`);
  check('8c: msg includes "%" character',    msg.includes('%'),    `msg: "${msg.slice(0,120)}"`);
}

// ── Test 9: Alternate array not mutated ──────────────────────────────────────
console.log('\nTest 9: alternate array is not mutated');
{
  const primary   = [makeSpan(0, 1000)];
  const alternate = [makeSpan(0, 100)];
  const altBefore = JSON.stringify(alternate);
  compareExtractions(primary, alternate);
  check('9: alternate unchanged',            JSON.stringify(alternate) === altBefore);
}

// ── Test 10: Text path has no parse_warnings ─────────────────────────────────
console.log('\nTest 10: parseSource({ text }) — text path skips dual-pass');
{
  const spans = await parseSource({ text: 'Hello world, this is a plain text input.' });
  check('10a: returns array',                Array.isArray(spans) && spans.length > 0);
  check('10b: no parse_warnings',            !spans[0].parse_warnings || spans[0].parse_warnings.length === 0);
}

// ── Test 11: Clean DOCX → no warnings ───────────────────────────────────────
console.log('\nTest 11: clean minimal DOCX — both mammoth passes should agree');
{
  const PARA1 = 'Rule 505: No-collision rule. A runner must slide or divert course when the catcher has possession.';
  const PARA2 = 'Rule 506: Obstruction. A fielder without possession who impedes the runner is guilty of obstruction.';
  const docxBuffer = buildMinimalDocx(PARA1, PARA2);
  const spans = await parseSource({ buffer: docxBuffer, mimeType: DOCX_MIME });
  check('11a: returns spans',                Array.isArray(spans) && spans.length > 0);
  const hasWarnings = spans.some(s => s.parse_warnings && s.parse_warnings.length > 0);
  check('11b: no parse_warnings on clean DOCX', !hasWarnings,
        hasWarnings ? `warnings: ${JSON.stringify(spans[0].parse_warnings)}` : '');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
