#!/usr/bin/env node
/**
 * scripts/smoke-ask-v2-rag.mjs
 *
 * Smoke tests for the V3 source-span RAG refactor of api/ask-v2.js.
 *
 * Covers the three requirements:
 *   1. Fake league → 404 league_not_found  (unchanged behaviour)
 *   2. BAMSBL must-slide question → active_version_id present in response
 *      (requires BAMSBL to have an ACTIVE rulebook_version; if still DRAFT
 *       the test expects the correct rulebook_not_active error instead)
 *   3. No returned source_id belongs to a legacy NULL-version row in the DB
 *      (DB-level verification via a direct Postgres query)
 *
 * Usage:
 *   node scripts/smoke-ask-v2-rag.mjs
 *   ASK_URL=http://localhost:3000 node scripts/smoke-ask-v2-rag.mjs
 *   RULEBOOK_DEBUG=1 node scripts/smoke-ask-v2-rag.mjs  (for extra span detail)
 *
 * The DB check in test 3 reads DATABASE_URL from .env.local automatically.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ── .env.local loader (for DB check) ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

// ── Helpers ────────────────────────────────────────────────────────────────────

const BASE = (process.env.ASK_URL ?? 'https://heyblu.ai') + '/api/ask-v2';

let passed = 0;
let failed = 0;
let skipped = 0;

async function post(body) {
  const res = await fetch(BASE, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? '  —  ' + detail : ''}`);
    failed++;
  }
}

function skip(label, reason) {
  console.log(`  –  ${label}  [SKIP: ${reason}]`);
  skipped++;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Smoke tests ────────────────────────────────────────────────────────────────

console.log(`\n━━━  ask-v2 V3 RAG Smoke Test  ━━━`);
console.log(`Target : ${BASE}\n`);

// ── Test 1: Fake league → 404 league_not_found ─────────────────────────────────

console.log('Test 1: fake league slug → 404 league_not_found');
{
  const r = await post({ question: 'what is the must slide rule?', league: 'FAKE_LEAGUE_XYZ_999' });
  check('HTTP 404',                    r.status === 404,
        `got ${r.status}`);
  check('error = league_not_found',    r.body.error === 'league_not_found',
        `got "${r.body.error}"`);
  check('no state field leaked',       !('state' in r.body),
        `state was "${r.body.state}" — should not be set on error`);
  check('no active_version_id leaked', !('active_version_id' in r.body),
        'active_version_id was present on a 404 response');
}

// ── Test 2: BAMSBL must-slide question ─────────────────────────────────────────
//
// Two possible correct outcomes:
//   A. BAMSBL has an ACTIVE version → 200 answered with active_version_id present
//   B. BAMSBL has only a DRAFT version → 404 rulebook_not_active (correct V3 behaviour)
//
// Either outcome proves the new code path is exercised correctly.
// A failing test means a 200 without active_version_id (old code still running)
// or any non-404 error response.

console.log('\nTest 2: BAMSBL "must-slide" → active_version_id present (or correct not-active error)');
let bamsblSourceIds = [];
let bamsblActiveVersionId = null;
{
  const r = await post({
    question: 'can a runner skip a base on a must-slide play?',
    league:   'bamsbl',
  });

  if (r.status === 200 && r.body.state === 'answered') {
    // Path A: BAMSBL is active — verify V3 metadata is present
    check('HTTP 200',                         r.status === 200,
          `got ${r.status}`);
    check('state = answered',                 r.body.state === 'answered',
          `got "${r.body.state}"`);
    check('league_slug = bamsbl',             r.body.league_slug === 'bamsbl',
          `got "${r.body.league_slug}"`);

    const versionId = r.body.active_version_id;
    check('active_version_id is a UUID',      UUID_RE.test(versionId ?? ''),
          `got "${versionId}"`);

    check('retrieved_source_ids is an array', Array.isArray(r.body.retrieved_source_ids),
          `got ${typeof r.body.retrieved_source_ids}`);
    check('at least 1 source span retrieved', (r.body.retrieved_source_ids?.length ?? 0) > 0,
          `got ${r.body.retrieved_source_ids?.length}`);

    const allUuids = (r.body.retrieved_source_ids ?? []).every(id => UUID_RE.test(id));
    check('all source IDs are valid UUIDs',   allUuids,
          'one or more IDs failed UUID format check');

    check('cited_rule_numbers is an array',   Array.isArray(r.body.cited_rule_numbers),
          `got ${typeof r.body.cited_rule_numbers}`);

    check('reply is non-empty',               typeof r.body.reply === 'string' && r.body.reply.length > 20,
          'reply missing or too short');

    check('no usedFallback',                  r.body.usedFallback !== true,
          'usedFallback was true');

    bamsblSourceIds       = r.body.retrieved_source_ids ?? [];
    bamsblActiveVersionId = versionId;

    if (process.env.RULEBOOK_DEBUG === '1' && r.body._debug) {
      console.log(`\n  [debug] retrieval_method=${r.body._debug.retrieval_method}  spans=${r.body._debug.span_count}`);
      for (const s of r.body._debug.spans ?? []) {
        console.log(`    ${s.source_id.slice(0, 8)}…  Rule ${s.rule_numbers ?? '?'}  p.${s.page_start ?? '?'}  rank=${Number(s.rank).toFixed(4)}`);
        console.log(`      "${s.text_preview}"`);
      }
    }

  } else if (r.status === 404 && r.body.error === 'rulebook_not_active') {
    // Path B: BAMSBL exists but has no ACTIVE version yet — correct V3 behaviour
    check('HTTP 404 (not-active)',            r.status === 404,
          `got ${r.status}`);
    check('error = rulebook_not_active',      r.body.error === 'rulebook_not_active',
          `got "${r.body.error}"`);
    check('no state field on not-active',     !('state' in r.body),
          `state was "${r.body.state}"`);
    console.log('\n  ⚠  BAMSBL has no active version — run activate-version.mjs --yes first to test Path A.');
    skip('V3 metadata fields (requires active version)', 'no active rulebook version');

  } else {
    // Unexpected response — definite failure
    check('expected 200-answered or 404-rulebook_not_active',
          false,
          `got HTTP ${r.status}  error="${r.body.error}"  state="${r.body.state}"`);
  }
}

// ── Test 3: No legacy NULL-version source span in returned IDs ─────────────────
//
// Query the DB to confirm that every returned source_id is attached to a
// rule_document whose version_id matches the active_version_id returned in
// the response — i.e. no legacy row (rulebook_version_id IS NULL) slipped through.

console.log('\nTest 3: DB verification — no returned source_id belongs to a legacy NULL-version rule');

if (bamsblSourceIds.length === 0 || !bamsblActiveVersionId) {
  skip('DB source-version check', 'no source IDs returned (BAMSBL not active or test 2 failed)');
} else if (!process.env.DATABASE_URL) {
  skip('DB source-version check', 'DATABASE_URL not set');
} else {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // For each returned source_id, confirm:
    //   rule_sources → rule_documents → version_id = bamsblActiveVersionId
    const res = await pool.query(`
      SELECT rs.id AS source_id, rd.version_id
      FROM   rule_sources   rs
      JOIN   rule_documents rd ON rd.id = rs.document_id
      WHERE  rs.id = ANY($1::uuid[])
    `, [bamsblSourceIds]);

    const wrongVersion = res.rows.filter(r => r.version_id !== bamsblActiveVersionId);
    const nullVersion  = res.rows.filter(r => r.version_id === null);

    check(
      `All ${bamsblSourceIds.length} source IDs belong to active version ${bamsblActiveVersionId.slice(0, 8)}…`,
      wrongVersion.length === 0,
      wrongVersion.length > 0
        ? `${wrongVersion.length} source(s) have wrong version_id: ` +
          wrongVersion.map(r => `${r.source_id.slice(0, 8)}…→${(r.version_id ?? 'NULL')}`).join(', ')
        : '',
    );

    check(
      'No returned source belongs to a NULL-version rule_document',
      nullVersion.length === 0,
      nullVersion.length > 0
        ? `${nullVersion.length} legacy source(s) found: ` +
          nullVersion.map(r => r.source_id.slice(0, 8) + '…').join(', ')
        : '',
    );

    // Also check via the rules link: no rule with rulebook_version_id IS NULL
    const legacyRuleRes = await pool.query(`
      SELECT COUNT(*) AS n
      FROM   rule_source_links rsl
      JOIN   rules r ON r.id = rsl.rule_id
      WHERE  rsl.source_id = ANY($1::uuid[])
        AND  r.rulebook_version_id IS NULL
    `, [bamsblSourceIds]);
    const legacyRuleCount = Number(legacyRuleRes.rows[0].n);

    check(
      'No returned source is linked to a legacy NULL-version rule',
      legacyRuleCount === 0,
      `${legacyRuleCount} source-rule link(s) point to a rule with rulebook_version_id IS NULL`,
    );

  } finally {
    await pool.end();
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(56));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('─'.repeat(56) + '\n');

if (failed > 0) process.exit(1);
