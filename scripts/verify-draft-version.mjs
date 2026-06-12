/**
 * scripts/verify-draft-version.mjs
 *
 * Post-ingest correctness audit for a draft rulebook version.
 * Prints every metric the accuracy directive requires before activation.
 *
 * Usage:
 *   node scripts/verify-draft-version.mjs --version-id <uuid>
 *   node scripts/verify-draft-version.mjs --league bamsbl   (auto-detects latest draft)
 *
 * Metrics reported:
 *   1.  Draft version id + league + season
 *   2.  Rule count
 *   3.  Source span count
 *   4.  Unlinked rule count      (rules with no rule_source_links row)
 *   5.  Uncovered span count     (rule_sources rows with no rule_source_links row)
 *   6.  Duplicate rule_number count   (same numbered rule appears > 1 time per version)
 *   7.  Duplicate atom_key count      (must be 0 — structural invariant)
 *   8.  Parse warnings summary
 *   9.  Body source-slice verification  (every rules.body findable in cited source text)
 */

import pg    from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { findNormalizedSubstring } from '../lib/ingest/utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ───────────────────────────────────────────────────────────
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

// ── Parse args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const versionIdArg = arg('--version-id');
const leagueArg    = arg('--league');

if (!versionIdArg && !leagueArg) {
  console.error('Usage: node scripts/verify-draft-version.mjs --version-id <uuid>');
  console.error('       node scripts/verify-draft-version.mjs --league <slug>  (auto-detects latest draft)');
  process.exit(1);
}

const { Pool } = pg;
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const HR     = '─'.repeat(64);

try {
  // ── Resolve version ID ──────────────────────────────────────────────────────
  let versionId = versionIdArg;

  if (!versionId) {
    const r = await client.query(`
      SELECT rv.id, rv.season, rv.status, l.name AS league_name, rv.created_at
      FROM   rulebook_versions rv
      JOIN   leagues l ON l.id = rv.league_id
      WHERE  l.slug = $1 AND rv.status = 'draft'
      ORDER  BY rv.created_at DESC
      LIMIT  1
    `, [leagueArg]);
    if (!r.rows.length) {
      console.error(`No draft version found for league "${leagueArg}".`);
      process.exit(1);
    }
    versionId = r.rows[0].id;
    console.log(`  Auto-detected latest draft: ${versionId} (${r.rows[0].league_name}, created ${r.rows[0].created_at.toISOString().slice(0, 19)})`);
  }

  // ── 0. Version header ───────────────────────────────────────────────────────
  const vr = await client.query(`
    SELECT rv.id, rv.status, rv.season, rv.source_hash, rv.created_at,
           l.name AS league_name, l.slug AS league_slug
    FROM   rulebook_versions rv
    JOIN   leagues l ON l.id = rv.league_id
    WHERE  rv.id = $1
  `, [versionId]);

  if (!vr.rows.length) {
    console.error(`Version ${versionId} not found.`);
    process.exit(1);
  }

  const v = vr.rows[0];
  console.log(`\n━━━  Draft Version Audit  ━━━\n`);
  console.log(`${HR}`);
  console.log(`  Version ID  : ${v.id}`);
  console.log(`  League      : ${v.league_name} (${v.league_slug})`);
  console.log(`  Season      : ${v.season ?? 'n/a'}`);
  console.log(`  Status      : ${v.status}`);
  console.log(`  Source hash : ${v.source_hash?.slice(0, 16) ?? 'n/a'}…`);
  console.log(`  Created     : ${v.created_at?.toISOString().slice(0, 19)}`);
  console.log(`${HR}\n`);

  if (v.status !== 'draft') {
    console.warn(`  ⚠ Version status is "${v.status}", not "draft". Continuing audit anyway.`);
  }

  // ── 1. Rule count ───────────────────────────────────────────────────────────
  const ruleCountR = await client.query(
    `SELECT COUNT(*) AS n FROM rules WHERE rulebook_version_id = $1`, [versionId],
  );
  const ruleCount = Number(ruleCountR.rows[0].n);
  console.log(`1. Rule count                  : ${ruleCount}`);

  // ── 2. Source span count ────────────────────────────────────────────────────
  const spanCountR = await client.query(`
    SELECT COUNT(*) AS n
    FROM   rule_sources rs
    JOIN   rule_documents rd ON rd.id = rs.document_id
    WHERE  rd.version_id = $1
  `, [versionId]);
  const spanCount = Number(spanCountR.rows[0].n);
  console.log(`2. Source span count           : ${spanCount}`);

  // ── 3. Unlinked rules ───────────────────────────────────────────────────────
  const unlinkedR = await client.query(`
    SELECT COUNT(*) AS n
    FROM   rules ru
    WHERE  ru.rulebook_version_id = $1
      AND  NOT EXISTS (
        SELECT 1 FROM rule_source_links rsl WHERE rsl.rule_id = ru.id
      )
  `, [versionId]);
  const unlinked = Number(unlinkedR.rows[0].n);
  console.log(`3. Unlinked rules (no links)   : ${unlinked}  ${unlinked === 0 ? '✓' : '✗ FAIL'}`);

  // ── 4. Uncovered spans ──────────────────────────────────────────────────────
  const uncoveredR = await client.query(`
    SELECT COUNT(*) AS n
    FROM   rule_sources rs
    JOIN   rule_documents rd ON rd.id = rs.document_id
    WHERE  rd.version_id = $1
      AND  NOT EXISTS (
        SELECT 1 FROM rule_source_links rsl WHERE rsl.source_id = rs.id
      )
  `, [versionId]);
  const uncovered = Number(uncoveredR.rows[0].n);
  console.log(`4. Uncovered spans             : ${uncovered}  ${uncovered === 0 ? '✓' : '⚠ warning'}`);

  // ── 5. Duplicate rule_number count ──────────────────────────────────────────
  const dupRuleNumR = await client.query(`
    SELECT rule_number, COUNT(*) AS cnt
    FROM   rules
    WHERE  rulebook_version_id = $1
      AND  rule_number != ''
    GROUP  BY rule_number
    HAVING COUNT(*) > 1
    ORDER  BY cnt DESC, rule_number
    LIMIT  10
  `, [versionId]);
  const dupRuleNumCount = dupRuleNumR.rows.length;
  console.log(`5. Dup rule_numbers (top 10)   : ${dupRuleNumCount}`);
  if (dupRuleNumCount > 0) {
    for (const r of dupRuleNumR.rows) {
      console.log(`     rule_number "${r.rule_number}"  ×${r.cnt} (expected — different atom bodies per obligation)`);
    }
  } else {
    console.log('   (none — each rule_number appears exactly once)');
  }

  // ── 6. Duplicate atom_key count ─────────────────────────────────────────────
  const dupAtomKeyR = await client.query(`
    SELECT atom_key, COUNT(*) AS cnt
    FROM   rules
    WHERE  rulebook_version_id = $1
    GROUP  BY atom_key
    HAVING COUNT(*) > 1
    ORDER  BY cnt DESC
    LIMIT  10
  `, [versionId]);
  const dupAtomKeyCount = dupAtomKeyR.rows.length;
  const atomKeyPass = dupAtomKeyCount === 0;
  console.log(`6. Dup atom_keys               : ${dupAtomKeyCount}  ${atomKeyPass ? '✓' : '✗ FAIL — structural invariant violated'}`);
  if (!atomKeyPass) {
    for (const r of dupAtomKeyR.rows) {
      console.log(`     atom_key "${r.atom_key}"  ×${r.cnt}`);
    }
  }

  // ── 7. Parse warnings ───────────────────────────────────────────────────────
  const warnR = await client.query(`
    SELECT
      COUNT(*) AS total_spans,
      COUNT(*) FILTER (WHERE jsonb_array_length(parse_warnings) > 0) AS warned_spans,
      (
        SELECT parse_warnings->0 #>> '{}'
        FROM   rule_sources rs2
        JOIN   rule_documents rd2 ON rd2.id = rs2.document_id
        WHERE  rd2.version_id = $1
          AND  jsonb_array_length(parse_warnings) > 0
        LIMIT  1
      ) AS first_warning_sample
    FROM rule_sources rs
    JOIN rule_documents rd ON rd.id = rs.document_id
    WHERE rd.version_id = $1
  `, [versionId]);

  const warnRow = warnR.rows[0];
  const warnedSpans = Number(warnRow.warned_spans);
  console.log(`7. Parse warnings`);
  console.log(`   Total spans          : ${warnRow.total_spans}`);
  console.log(`   Spans with warnings  : ${warnedSpans}  ${warnedSpans === 0 ? '✓' : '⚠'}`);
  if (warnedSpans > 0 && warnRow.first_warning_sample) {
    console.log(`   Sample warning       : ${String(warnRow.first_warning_sample).slice(0, 120)}`);
  }

  // ── 8. Body source-slice verification ───────────────────────────────────────
  // For every rule in this version, load its body and its linked source span texts.
  // Verify that body is findable (via normalized substring match) in the joined span text.
  // A correct source-sliced body always passes; an AI-authored body may fail.

  console.log(`\n8. Body source-slice verification`);
  console.log(`   Loading rules + source spans…`);

  const rulesR = await client.query(`
    SELECT ru.id, ru.atom_key, ru.rule_number, ru.title,
           ru.body,
           array_agg(rs.exact_text ORDER BY rs.char_start NULLS LAST) AS span_texts,
           array_agg(rs.id        ORDER BY rs.char_start NULLS LAST) AS span_ids
    FROM   rules ru
    JOIN   rule_source_links rsl ON rsl.rule_id  = ru.id
    JOIN   rule_sources      rs  ON rs.id        = rsl.source_id
    WHERE  ru.rulebook_version_id = $1
    GROUP  BY ru.id, ru.atom_key, ru.rule_number, ru.title, ru.body
  `, [versionId]);

  let bodyPass = 0;
  let bodyFail = 0;
  const bodyFailSamples = [];

  for (const row of rulesR.rows) {
    const body      = row.body;
    const spanTexts = row.span_texts;         // ordered by char_start

    // Single-span fast path, then cross-span fallback — mirrors sliceAtomBodyFromSource
    let found = false;
    for (const st of spanTexts) {
      if (findNormalizedSubstring(st, body) !== null) { found = true; break; }
    }
    if (!found && spanTexts.length > 1) {
      const joined = spanTexts.join('\n');
      if (findNormalizedSubstring(joined, body) !== null) found = true;
    }

    if (found) {
      bodyPass++;
    } else {
      bodyFail++;
      if (bodyFailSamples.length < 5) {
        bodyFailSamples.push({
          atom_key:    row.atom_key,
          rule_number: row.rule_number,
          title:       row.title,
          body_preview: body.slice(0, 80),
        });
      }
    }
  }

  // Rules that have no source links at all can't be verified
  const unverifiable = ruleCount - rulesR.rows.length;
  const bodyVerifyPass = bodyFail === 0;

  console.log(`   Rules verified       : ${rulesR.rows.length} of ${ruleCount}`);
  console.log(`   Body ✓ match         : ${bodyPass}`);
  console.log(`   Body ✗ mismatch      : ${bodyFail}  ${bodyVerifyPass ? '✓' : '✗ FAIL'}`);
  if (unverifiable > 0) {
    console.log(`   Unverifiable (no links): ${unverifiable}`);
  }
  if (bodyFailSamples.length > 0) {
    console.log(`\n   Mismatch samples (up to 5):`);
    for (const s of bodyFailSamples) {
      console.log(`     [${s.rule_number || 'unnumbered'}] "${s.title}" — body: "${s.body_preview}…"`);
    }
  }

  // ── Final summary ───────────────────────────────────────────────────────────
  console.log(`\n${HR}`);
  console.log('  AUDIT SUMMARY');
  console.log(`${HR}`);

  const allGreen = unlinked === 0 && atomKeyPass && bodyVerifyPass;
  console.log(`  Draft version ID  : ${versionId}`);
  console.log(`  Rule count        : ${ruleCount}`);
  console.log(`  Span count        : ${spanCount}`);
  console.log(`  Unlinked rules    : ${unlinked}  ${unlinked === 0 ? '✓' : '✗'}`);
  console.log(`  Uncovered spans   : ${uncovered}  ${uncovered === 0 ? '✓' : '⚠'}`);
  console.log(`  Dup rule_numbers  : ${dupRuleNumCount}  (expected for multi-obligation rules)`);
  console.log(`  Dup atom_keys     : ${dupAtomKeyCount}  ${atomKeyPass ? '✓' : '✗ STRUCTURAL FAIL'}`);
  console.log(`  Warned spans      : ${warnedSpans}`);
  console.log(`  Body slice ok     : ${bodyVerifyPass ? `✓ all ${bodyPass} verified` : `✗ ${bodyFail} mismatch(es)`}`);
  console.log();
  console.log(`  Overall           : ${allGreen ? '✓ PASS — safe to activate' : '⚠ ISSUES — review before activating'}`);
  console.log(`${HR}\n`);

} finally {
  client.release();
  await pool.end();
}
