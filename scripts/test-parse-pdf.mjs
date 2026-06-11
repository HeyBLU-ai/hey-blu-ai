#!/usr/bin/env node
/**
 * scripts/test-parse-pdf.mjs
 *
 * Tests the PDF extraction path in lib/ingest/parse-source.mjs.
 *
 * Strategy: build a minimal valid one-page PDF entirely in-memory so the
 * test has no external file dependencies.  The PDF contains a single text
 * string ("Must slide rule.") rendered with a standard Helvetica Type1 font.
 *
 * Assertions:
 *   1. parseSource({ buffer, mimeType: 'application/pdf' }) resolves without throwing.
 *   2. Returns a non-empty array.
 *   3. Each span has:  seq (number), text (non-empty string), page (number >= 1).
 *   4. charStart < charEnd.
 *   5. The expected phrase "Must slide rule" appears in at least one span.
 *   6. Spans are ordered by seq (0, 1, 2, …).
 *
 * Also tests the filePath path using a .pdf extension so mime inference fires.
 */

import { writeFile, unlink } from 'node:fs/promises';
import { join }              from 'node:path';
import { tmpdir }            from 'node:os';
import { parseSource }       from '../lib/ingest/parse-source.mjs';

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

// ─────────────────────────────────────────────────────────────────────────────
// Minimal valid single-page PDF
//
// Byte offsets are pre-computed; any white-space change here will invalidate
// the xref table (pdfjs will still recover via fallback parsing, but having
// a valid xref is better for reliability).
//
// Layout:
//   obj 1: Catalog     — offset   9
//   obj 2: Pages       — offset  58
//   obj 3: Page        — offset 115
//   obj 4: ContentStream — offset 241  (length 48)
//   obj 5: Font/Helvetica— offset 338
//   xref:               — offset 408
// ─────────────────────────────────────────────────────────────────────────────
function makeMinimalPdf() {
  const body = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    'endobj',
    '4 0 obj',
    '<< /Length 48 >>',
    'stream',
    'BT /F1 12 Tf 72 720 Td (Must slide rule.) Tj ET',
    'endstream',
    'endobj',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
  ].join('\n') + '\n';

  const xref = [
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000241 00000 n ',
    '0000000338 00000 n ',
    'trailer',
    '<< /Size 6 /Root 1 0 R >>',
    'startxref',
    '408',
    '%%EOF',
  ].join('\n') + '\n';

  return Buffer.from(body + xref, 'utf8');
}

console.log('\n━━━  parse-source PDF extraction test  ━━━\n');

const pdfBuffer = makeMinimalPdf();
console.log(`Minimal PDF size: ${pdfBuffer.length} bytes`);

// ── Test 1: buffer + explicit mimeType ────────────────────────────────────────
console.log('\nTest 1: parseSource({ buffer, mimeType: "application/pdf" })');
let spans;
try {
  spans = await parseSource({ buffer: pdfBuffer, mimeType: 'application/pdf' });
  check('resolves without throwing',          true);
} catch (e) {
  check('resolves without throwing',          false, e.message);
  console.error('\nFull error:', e);
  spans = null;
}

if (spans) {
  check('returns an array',                   Array.isArray(spans));
  check('array is non-empty',                 spans.length > 0, `got ${spans.length}`);

  for (const span of spans) {
    check(`span[${span.seq}] seq is a number`,    typeof span.seq  === 'number');
    check(`span[${span.seq}] text is non-empty`,   typeof span.text === 'string' && span.text.trim().length > 0);
    check(`span[${span.seq}] page >= 1`,           typeof span.page === 'number' && span.page >= 1, `got ${span.page}`);
    check(`span[${span.seq}] charStart < charEnd`, span.charStart < span.charEnd,
          `charStart=${span.charStart} charEnd=${span.charEnd}`);
  }

  const allText = spans.map(s => s.text).join(' ');
  check('extracted text includes "Must slide rule"', allText.includes('Must slide rule'),
        `full text: "${allText.slice(0, 200)}"`);

  const seqs = spans.map(s => s.seq);
  const isOrdered = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1);
  check('spans ordered by seq (0,1,2,…)',     isOrdered, `seqs: ${seqs.join(',')}`);

  console.log(`\n  Spans returned: ${spans.length}`);
  for (const s of spans) {
    console.log(`    seq=${s.seq} page=${s.page} chars=${s.charStart}..${s.charEnd} text="${s.text.slice(0, 80)}"`);
  }
}

// ── Test 2: filePath with .pdf extension (mime inferred) ─────────────────────
console.log('\nTest 2: parseSource({ filePath }) — mime inferred from .pdf extension');
const tmpPath = join(tmpdir(), `test-parse-${Date.now()}.pdf`);
try {
  await writeFile(tmpPath, pdfBuffer);
  const fpSpans = await parseSource({ filePath: tmpPath });
  check('filePath resolves without throwing',  true);
  check('filePath returns array',              Array.isArray(fpSpans));
  check('filePath returns non-empty array',    fpSpans.length > 0);
  const fpText = fpSpans.map(s => s.text).join(' ');
  check('filePath text includes "Must slide rule"', fpText.includes('Must slide rule'));
} catch (e) {
  check('filePath resolves without throwing',  false, e.message);
  console.error('\nFull error:', e);
} finally {
  await unlink(tmpPath).catch(() => {});
}

// ── Test 3: empty-league error guard still works (regression) ─────────────────
console.log('\nTest 3: parseSource() with no args still throws (regression)');
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
