#!/usr/bin/env node
/**
 * Build the 2026 Little League Master Playing Rules DOCX.
 *
 * Merges:
 *   - 2024 base playing rules (DOCX if present, else PDF)
 *   - 2025 significant-changes DOCX
 *   - 2026 significant-changes DOCX
 *
 * Usage:
 *   node scripts/build-master-ll-book.mjs
 *   node scripts/build-master-ll-book.mjs --verify-only
 */
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildMasterLittleLeagueBook } from '../lib/ingest/ll-master-builder.mjs';
import { parseDocxToGraph } from '../lib/ingest/docx-markdown.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PATHS = {
  baseDocx: [
    resolve(ROOT, 'rulebooks/raw/2024-rules-Little League.docx'),
    resolve(ROOT, 'rulebooks/raw/2024-rules-Little-League.docx'),
  ].find((p) => existsSync(p)),
  basePdf: resolve(ROOT, 'rulebooks/2024-rules-Little League.pdf'),
  updates2025: resolve(ROOT, 'rulebooks/raw/2025-rulebook-significant-changes.docx'),
  updates2026: resolve(ROOT, 'rulebooks/raw/2026-rulebook-significant-changes.docx'),
  output: resolve(ROOT, 'rulebooks/2026-Little-League-Master-Playing-Rules.docx'),
};

const verifyOnly = process.argv.includes('--verify-only');

function requireFile(path, label) {
  if (!existsSync(path)) {
    console.error(`Missing ${label}: ${path}`);
    process.exit(1);
  }
}

requireFile(PATHS.updates2025, '2025 updates');
requireFile(PATHS.updates2026, '2026 updates');
if (!PATHS.baseDocx && !existsSync(PATHS.basePdf)) {
  console.error('Missing base rulebook. Expected one of:');
  console.error('  rulebooks/raw/2024-rules-Little League.docx');
  console.error('  rulebooks/raw/2024-rules-Little-League.docx');
  console.error(`  ${PATHS.basePdf}`);
  process.exit(1);
}

const result = await buildMasterLittleLeagueBook({
  baseDocxPath: PATHS.baseDocx,
  basePdfPath: PATHS.basePdf,
  updates2025Path: PATHS.updates2025,
  updates2026Path: PATHS.updates2026,
  outputPath: PATHS.output,
});

if (!verifyOnly) {
  writeFileSync(PATHS.output, result.buffer);
}

console.log('\n2026 Little League Master Playing Rules — build summary');
console.log('─'.repeat(56));
console.log(`Base source:        ${result.baseSource}${PATHS.baseDocx ? ` (${PATHS.baseDocx})` : ` (pdf fallback: ${PATHS.basePdf})`}`);
console.log(`Base text chars:    ${result.baseChars.toLocaleString()}`);
console.log(`Major sections:     ${result.majorSections}`);
console.log(`Rule blocks:        ${result.ruleBlocks}`);
console.log(`Updates parsed:     ${result.updatesParsed}`);
console.log(`Updates applied:    ${result.updatesApplied}`);
console.log(`Output bytes:       ${result.outputBytes.toLocaleString()}`);
console.log(`Output path:        ${PATHS.output}`);

const uniqueIds = [...new Set(result.ruleIds)].sort((a, b) => {
  const [am, as] = a.split('.').map(Number);
  const [bm, bs] = b.split('.').map(Number);
  return am - bm || (as ?? 0) - (bs ?? 0);
});
console.log(`Unique rule IDs:    ${uniqueIds.length}`);
console.log(`Sample IDs:         ${uniqueIds.slice(0, 15).join(', ')}…`);

const mustHave = ['1.01', '1.10', '1.11', '3.04', '4.04', '6.06', '7.14', '8.01'];
const missing = mustHave.filter((id) => !uniqueIds.includes(id));
if (missing.length) {
  console.warn(`\n⚠ Expected rule IDs not found: ${missing.join(', ')}`);
} else {
  console.log('\n✓ Core rule IDs present (1.01, 1.10, 1.11, 3.04, 4.04, 6.06, 7.14, 8.01)');
}

// Verify DOCX is ingestible
const graph = await parseDocxToGraph(result.buffer);
console.log(`\nIngest dry-run:      ${graph.sections.length} sections, ${graph.nodes.length} nodes, ${graph.chunks.length} chunks`);
if (graph.nodes.length < 50) {
  console.warn('⚠ Low node count — check formatting');
} else {
  console.log('✓ DOCX structure looks ingestible');
}

if (verifyOnly) {
  console.log('\n(--verify-only: output file not written)');
}
