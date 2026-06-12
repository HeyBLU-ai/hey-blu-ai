/**
 * scripts/inspect-real-file.mjs
 *
 * Parse a local PDF or DOCX file through parseSource() and print a
 * human-readable span summary to the console.
 *
 * Does NOT write to the database or call any AI API.
 *
 * Usage:
 *   node scripts/inspect-real-file.mjs <relative-path-to-file>
 *
 * Examples:
 *   node scripts/inspect-real-file.mjs docs/rulebook.pdf
 *   node scripts/inspect-real-file.mjs "docs/BLU Certification_ BLU Diamond & BLU Zone.docx"
 */

import { resolve } from 'node:path';
import { parseSource } from '../lib/ingest/parse-source.mjs';

const PREVIEW_CHARS = 200;
const HR            = '─'.repeat(72);

// ── Argument validation ───────────────────────────────────────────────────────
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/inspect-real-file.mjs <path-to-pdf-or-docx>');
  process.exit(1);
}

const absPath = resolve(filePath);
console.log(`\nInspecting: ${absPath}\n`);

// ── Parse ─────────────────────────────────────────────────────────────────────
let spans;
const startMs = Date.now();

try {
  spans = await parseSource({ filePath: absPath });
} catch (err) {
  console.error(`\nparse failed: ${err.message}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startMs;

// ── Summary header ─────────────────────────────────────────────────────────────
const totalChars    = spans.reduce((n, s) => n + s.text.length, 0);
const warnCount     = spans.filter(s => s.parse_warnings?.length > 0).length;

console.log(HR);
console.log(`PARSE SUMMARY`);
console.log(HR);
console.log(`  File       : ${absPath.replace(/\\/g, '/')}`);
console.log(`  Spans      : ${spans.length}`);
console.log(`  Total chars: ${totalChars.toLocaleString()}`);
console.log(`  Parse time : ${elapsedMs} ms`);
console.log(`  Spans with warnings: ${warnCount}`);
console.log(HR);

// ── Per-span detail ────────────────────────────────────────────────────────────
for (const span of spans) {
  const preview  = span.text.slice(0, PREVIEW_CHARS).replace(/\n/g, ' ');
  const ellipsis = span.text.length > PREVIEW_CHARS ? '…' : '';
  const page     = span.page != null ? `p${span.page}` : 'p?';
  const chars    = `chars ${span.charStart ?? '?'}–${span.charEnd ?? '?'}`;
  const heading  = span.heading ? ` [${span.heading}]` : '';
  const warn     = span.parse_warnings?.length
    ? `\n  ⚠ WARNINGS (${span.parse_warnings.length}): ${span.parse_warnings[0].slice(0, 120)}`
    : '';

  console.log(`\nSpan #${String(span.seq).padStart(3, '0')}  ${page}  ${chars}${heading}`);
  console.log(`  "${preview}${ellipsis}"`);
  if (warn) console.log(warn);
}

console.log('\n' + HR);
console.log(`Done — ${spans.length} spans from ${absPath.split(/[\\/]/).pop()}`);
console.log(HR + '\n');
