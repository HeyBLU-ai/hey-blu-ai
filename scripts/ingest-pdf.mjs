#!/usr/bin/env node
/**
 * scripts/ingest-pdf.mjs — V3 Rulebook Ingestion Orchestrator
 *
 * Runs the full V3 pipeline against a local PDF or DOCX file:
 *
 *   1. parseSource          → deterministic text extraction → SourceSpan[]
 *   2. createDraftVersion   → rulebook_versions + rule_documents rows
 *   3. identifyBoundaries   → AI rule segmentation (verbatim guard)
 *   4. createSourceSpans    → rule_sources rows (one per boundary)
 *   5. extractRuleAtoms     → rules + rule_source_links rows (verbatim guard)
 *   6. verifyCoverage       → deterministic page + quote audit
 *
 * Accuracy is the primary directive.  Steps 3 and 5 use AI, but both enforce
 * a VERBATIM GUARD — no AI-authored text ever reaches the database.
 *
 * On failure, the draft version row is deleted (which CASCADE-deletes
 * rule_documents and rule_sources) to prevent orphaned rows.
 *
 * Usage:
 *   node scripts/ingest-pdf.mjs <file-path> <league-slug> [options]
 *
 * Options:
 *   --season <label>   Season label, e.g. "2026" (default: current year)
 *   --sport  <sport>   baseball (default) | softball
 *   --dry-run          Parse + AI boundary/atom pass, but do NOT write to DB
 *
 * Examples:
 *   node scripts/ingest-pdf.mjs 2026bamsblrules.pdf bamsbl --season 2026
 *   node scripts/ingest-pdf.mjs "docs/rulebook.docx" little-league --dry-run
 *
 * Reads credentials from .env.local: DATABASE_URL, ANTHROPIC_API_KEY.
 */

import fs        from 'node:fs/promises';
import path      from 'node:path';
import crypto    from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg        from 'pg';
import Anthropic from '@anthropic-ai/sdk';

import { parseSource }       from '../lib/ingest/parse-source.mjs';
import { createDraftVersion } from '../lib/ingest/write-rulebook-version.mjs';
import { identifyBoundaries, createSourceSpans } from '../lib/ingest/create-source-spans.mjs';
import { extractRuleAtoms }   from '../lib/ingest/extract-rule-atoms.mjs';
import { verifyCoverage }     from '../lib/ingest/verify-coverage.mjs';

const { Pool }  = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const HR        = '─'.repeat(60);

// ── 0. Load .env.local ────────────────────────────────────────────────────────

console.log('\n━━━  HeyBLU V3 Ingest  ━━━\n');

try {
  const raw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq  = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.error('  ✗ .env.local not found.  Run: vercel env pull .env.local');
  process.exit(1);
}

const { DATABASE_URL, ANTHROPIC_API_KEY } = process.env;
if (!DATABASE_URL)      { console.error('  ✗ DATABASE_URL not set');      process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('  ✗ ANTHROPIC_API_KEY not set'); process.exit(1); }

// ── 1. Parse CLI arguments ────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? true : undefined;
}

const [fileArg, leagueSlug] = argv.filter(a => !a.startsWith('--') && argv.indexOf(a) < 2);
const season   = flag('--season') || String(new Date().getFullYear());
const sport    = flag('--sport')  || 'baseball';
const isDryRun = argv.includes('--dry-run');

if (!fileArg || !leagueSlug) {
  console.error(
    'Usage: node scripts/ingest-pdf.mjs <file-path> <league-slug> [options]\n' +
    '  --season <label>   e.g. "2026" (default: current year)\n' +
    '  --sport  <sport>   baseball (default) | softball\n' +
    '  --dry-run          Parse + AI pass, do NOT write to DB',
  );
  process.exit(1);
}

const filePath = path.isAbsolute(fileArg) ? fileArg : path.resolve(fileArg);

console.log(`  File   : ${filePath}`);
console.log(`  League : ${leagueSlug}`);
console.log(`  Season : ${season}`);
console.log(`  Sport  : ${sport}`);
console.log(`  Dry run: ${isDryRun}`);
console.log();

// ── 2. Read file + compute SHA-256 hash ───────────────────────────────────────

console.log(`${HR}\nStep 1 — Read source file\n${HR}`);

let fileBuffer;
try {
  fileBuffer = await fs.readFile(filePath);
} catch (err) {
  console.error(`  ✗ Cannot read file: ${err.message}`);
  process.exit(1);
}

const sourceSizeMB  = (fileBuffer.length / 1024 / 1024).toFixed(2);
const sourceHash    = crypto.createHash('sha256').update(fileBuffer).digest('hex');
const ext           = path.extname(filePath).toLowerCase();
const parseMethod   = ext === '.pdf' ? 'pdf-parse' : ext === '.docx' ? 'mammoth' : 'unknown';
const mimeType      = ext === '.pdf'  ? 'application/pdf'
                    : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    : null;

console.log(`  ✓ ${sourceSizeMB} MB  |  SHA-256: ${sourceHash.slice(0, 16)}…`);
console.log(`  ✓ Parse method: ${parseMethod}`);
console.log();

// ── 3. DB: look up league, check for duplicate hash ───────────────────────────

let db;
let leagueId;
let leagueName;

if (!isDryRun) {
  console.log(`${HR}\nStep 2 — Verify league and source hash\n${HR}`);

  db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // League lookup
  const leagueRes = await db.query(
    `SELECT id, name FROM leagues WHERE slug = $1`, [leagueSlug],
  );
  if (!leagueRes.rows.length) {
    console.error(`  ✗ League slug "${leagueSlug}" not found.`);
    const all = await db.query('SELECT slug, name FROM leagues ORDER BY name');
    console.log('  Available leagues:');
    all.rows.forEach(r => console.log(`    • ${r.slug}  (${r.name})`));
    await db.end();
    process.exit(1);
  }

  ({ id: leagueId, name: leagueName } = leagueRes.rows[0]);
  console.log(`  ✓ League: "${leagueName}" (${leagueId})`);

  // Duplicate hash check
  const dupRes = await db.query(
    `SELECT d.id, v.status, v.created_at
     FROM rule_documents d
     JOIN rulebook_versions v ON v.id = d.version_id
     WHERE d.league_id = $1 AND d.source_hash = $2`,
    [leagueId, sourceHash],
  );
  if (dupRes.rows.length) {
    const existing = dupRes.rows[0];
    console.warn(
      `  ⚠ WARNING: This file (SHA-256 ${sourceHash.slice(0, 16)}…) was already ingested\n` +
      `    for this league (version status: ${existing.status}, created: ${existing.created_at?.toISOString().slice(0, 10)}).\n` +
      `    Re-ingesting identical content is a no-op.  Aborting.\n` +
      `    If you intended to re-run, use a modified file or contact an admin.`,
    );
    await db.end();
    process.exit(1);
  }
  console.log('  ✓ No duplicate source hash found — safe to proceed');
  console.log();
}

// ── 4. Parse source file ──────────────────────────────────────────────────────

console.log(`${HR}\nStep 3 — Deterministic source parsing\n${HR}`);

let rawSpans;
const parseStart = Date.now();
try {
  rawSpans = await parseSource({ filePath, buffer: fileBuffer });
} catch (err) {
  console.error(`  ✗ parseSource failed: ${err.message}`);
  if (db) await db.end();
  process.exit(1);
}

const parseMs    = Date.now() - parseStart;
const totalChars = rawSpans.reduce((n, s) => n + s.text.length, 0);
const warnSpans  = rawSpans.filter(s => s.parse_warnings?.length > 0).length;

console.log(`  ✓ ${rawSpans.length} raw spans  |  ${totalChars.toLocaleString()} chars  |  ${parseMs}ms`);
if (warnSpans > 0) console.warn(`  ⚠ ${warnSpans} span(s) have parse_warnings — review before activating`);
console.log();

// ── 5. Create draft version row (skip in dry-run) ─────────────────────────────

let versionId  = null;
let documentId = null;

if (!isDryRun) {
  console.log(`${HR}\nStep 4 — Allocate draft version in DB\n${HR}`);
  try {
    ({ versionId, documentId } = await createDraftVersion({
      dbClient:     db,
      leagueId,
      season,
      sourceHash,
      documentMeta: {
        source_file:  path.basename(filePath),
        mime_type:    mimeType,
        parse_method: parseMethod,
      },
    }));
    console.log(`  ✓ rulebook_versions.id = ${versionId}`);
    console.log(`  ✓ rule_documents.id    = ${documentId}`);
    console.log();
  } catch (err) {
    console.error(`  ✗ createDraftVersion failed: ${err.message}`);
    await db.end();
    process.exit(1);
  }
}

// ── 6. AI boundary identification + source span DB inserts ────────────────────

console.log(`${HR}\nStep 5 — AI boundary identification (verbatim guard active)\n${HR}`);
console.log(`  Processing ${rawSpans.length} raw span(s) through ${process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5'}…`);

const anthropic    = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const subSpans     = [];
let   boundaryFail = false;

for (let i = 0; i < rawSpans.length; i++) {
  const span = rawSpans[i];
  process.stdout.write(`  Span ${String(i + 1).padStart(3)} / ${rawSpans.length}  (${span.text.length} chars)… `);

  let boundaries;
  try {
    boundaries = await identifyBoundaries({ span, anthropicClient: anthropic });
  } catch (err) {
    process.stdout.write(`FAILED\n`);
    console.error(`    ✗ identifyBoundaries error: ${err.message.slice(0, 200)}`);
    boundaryFail = true;
    // Treat the entire span as a single boundary so the pipeline can continue.
    boundaries = [{ charStart: span.charStart ?? 0, charEnd: span.charEnd ?? span.text.length, text: span.text }];
  }

  for (const b of boundaries) {
    subSpans.push({
      seq:           subSpans.length,
      text:          b.text,
      charStart:     b.charStart,
      charEnd:       b.charEnd,
      page:          span.page ?? null,
      heading:       span.heading ?? null,
      parse_warnings: span.parse_warnings ?? [],
    });
  }
  process.stdout.write(`${boundaries.length} boundary(s)\n`);
}

console.log(`\n  ✓ ${subSpans.length} sub-spans from boundary identification`);
if (boundaryFail) console.warn('  ⚠ Some boundary calls failed — whole-span fallbacks were used');
console.log();

// Insert sub-spans into rule_sources (skip in dry-run)
let spanIds = subSpans.map((_, i) => `dry-run-span-${i}`); // placeholder for dry-run

if (!isDryRun) {
  console.log(`${HR}\nStep 6 — Persist source spans to rule_sources\n${HR}`);

  let spanResult;
  try {
    spanResult = await createSourceSpans({
      dbClient:   db,
      documentId,
      versionId,  // also passed for potential legacy compat
      spans:      subSpans,
    });
    spanIds = spanResult.ids;
    console.log(`  ✓ ${spanResult.inserted} rule_sources rows inserted`);
    console.log();
  } catch (err) {
    await cleanupDraftVersion(db, versionId);
    console.error(`  ✗ createSourceSpans failed: ${err.message}`);
    await db.end();
    process.exit(1);
  }
}

// ── 7. AI rule atom extraction ────────────────────────────────────────────────

console.log(`${HR}\nStep 7 — AI rule atom extraction (verbatim guard active)\n${HR}`);

let atoms;
try {
  atoms = await extractRuleAtoms({
    spans:           subSpans,
    spanIds,
    anthropicClient: anthropic,
    // DB writes only when not dry-run
    dbClient: isDryRun ? undefined : db,
    leagueId: isDryRun ? undefined : leagueId,
    sport,
  });
  console.log(`  ✓ ${atoms.length} rule atom(s) extracted and verified`);
  console.log();
} catch (err) {
  if (!isDryRun) await cleanupDraftVersion(db, versionId);
  console.error(`  ✗ extractRuleAtoms failed: ${err.message.slice(0, 400)}`);
  if (db) await db.end();
  process.exit(1);
}

// ── 8. Coverage verification ──────────────────────────────────────────────────

console.log(`${HR}\nStep 8 — Coverage verification\n${HR}`);

const coverage = await verifyCoverage({
  spans:   subSpans,
  spanIds,
  atoms,
});

const mismatchCount = coverage.issues.filter(i => i.code === 'QUOTE_MISMATCH').length;
const uncovCount    = coverage.issues.filter(i => i.code === 'UNCOVERED_SPAN').length;
const lowDensCount  = coverage.issues.filter(i => i.code === 'LOW_DENSITY').length;

console.log(`  Coverage : ${coverage.isComplete ? '✓ complete' : `⚠ INCOMPLETE — missing pages: ${coverage.missingPages.join(', ')}`}`);
console.log(`  Pages    : ${coverage.coveredPages} / ${coverage.totalPages} covered`);
console.log(`  Spans    : ${coverage.coveredSpans} / ${coverage.spanCount} covered by atoms`);
console.log(`  Issues   : QUOTE_MISMATCH=${mismatchCount}  UNCOVERED_SPAN=${uncovCount}  LOW_DENSITY=${lowDensCount}`);

if (!coverage.ok && !isDryRun) {
  console.warn('\n  ⚠ Coverage check failed — draft version created but NOT recommended for activation.');
  console.warn('  Review the issues above, fix the source document, and re-ingest.');
}
console.log();

// ── 9. Summary ────────────────────────────────────────────────────────────────

console.log(HR);
console.log(isDryRun ? '  DRY RUN COMPLETE — no DB writes performed' : '  INGEST COMPLETE');
console.log(HR);
console.log(`  File           : ${path.basename(filePath)}`);
console.log(`  League         : ${leagueName ?? leagueSlug}`);
console.log(`  Season         : ${season}  |  Sport: ${sport}`);
console.log(`  Source hash    : ${sourceHash.slice(0, 16)}…`);
console.log(`  Raw spans      : ${rawSpans.length}`);
console.log(`  Sub-spans (DB) : ${subSpans.length}`);
console.log(`  Rule atoms     : ${atoms.length}`);
console.log(`  Coverage ok    : ${coverage.ok}`);

if (!isDryRun) {
  console.log(`\n  Version ID     : ${versionId}`);
  console.log(`  Document ID    : ${documentId}`);
  console.log(`\n  Status: DRAFT — run the activate script to make this version live.`);
}

if (atoms.length > 0) {
  console.log('\n  Preview (first 5 atoms):');
  atoms.slice(0, 5).forEach(a =>
    console.log(`    [${a.rule_number || 'N/A'}] ${a.title}  (${a.body.length} chars)`),
  );
}

console.log(`\n${HR}\n`);

if (db) await db.end();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Delete a draft version row.  CASCADE removes rule_documents and rule_sources.
 * Rules rows (from extractRuleAtoms) are NOT cascade-deleted — log a warning.
 *
 * @param {pg.Pool} dbClient
 * @param {string}  vid
 */
async function cleanupDraftVersion(dbClient, vid) {
  if (!vid) return;
  try {
    const res = await dbClient.query(
      `DELETE FROM rulebook_versions WHERE id = $1 AND status = 'draft' RETURNING id`,
      [vid],
    );
    if (res.rowCount > 0) {
      console.log(`  ✓ Cleaned up draft version ${vid} (CASCADE removed rule_documents + rule_sources)`);
      console.warn('  ⚠ Any rules rows created by extractRuleAtoms may remain — review rules table if needed');
    }
  } catch (cleanErr) {
    console.error(`  ✗ Cleanup failed: ${cleanErr.message}`);
  }
}
