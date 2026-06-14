/**
 * scripts/run-evals.mjs
 *
 * Runs the Critical Eval Suite against a live ask-v2 endpoint.
 *
 * For each eval_case row the runner executes SEVEN deterministic checks
 * (all checks must pass for the case to be considered passing):
 *
 *   CHECK 1 — State match
 *     body.state === expected_state
 *
 *   CHECK 2 — Rule number present (when expected)
 *     expected_rule_number appears in body.cited_rule_numbers
 *     (prefix/exact match, e.g. "505" matches "505.1")
 *
 *   CHECK 3 — Expected text in Evidence Bundle (when expected_source_text is set)
 *     expected_source_text is a case-insensitive substring of at least one
 *     retrieved rule_node's canonical text (title + body + comment/exception/
 *     penalty children). Skipped when expected_source_text is NULL.
 *
 *   CHECK 4 — Version isolation (answered / ruling states only)
 *     Every UUID in body.retrieved_source_ids is a rule_node.id belonging to
 *     body.active_version_id. Cross-version retrieval indicates isolation bug.
 *
 *   CHECK 5 — Valid rule_node citations (answered / ruling states only)
 *     Every UUID in body.retrieved_source_ids resolves to a rule_nodes row
 *     with a non-null rulebook_version_id.
 *
 *   CHECK 6 — Unsupported verifier never leaks a draft answer
 *     If body.verifier_status === 'unsupported', the state MUST be
 *     'unverifiable'.  A non-unverifiable state with 'unsupported'
 *     verifier status indicates the gate is broken.
 *
 *   CHECK 7 — needs_clarification structural integrity
 *     If state === 'needs_clarification':
 *       • body.current_question is an object with id, text, type, options
 *       • type is 'binary' or 'select'
 *       • options is a non-empty array
 *       • body.progress.answered and .remaining_estimated are numbers
 *     Exactly one current_question is returned (not zero, not an array).
 *
 * CHECKS 3–5 REQUIRE DATABASE ACCESS.
 *   The runner queries rule_nodes (Evidence Bundle IDs) in the same DB as the API.
 *
 * EXIT CODES:
 *   0 — all cases passed all checks
 *   1 — one or more cases failed, or a setup error occurred
 *
 * Usage:
 *   node scripts/run-evals.mjs
 *   ASK_URL=http://localhost:3000 node scripts/run-evals.mjs
 *   EVAL_TIER=critical node scripts/run-evals.mjs    (only critical cases)
 *   EVAL_LEAGUE=bamsbl node scripts/run-evals.mjs    (only one league)
 *   EVAL_DEBUG=1 node scripts/run-evals.mjs          (verbose failure output)
 *   SKIP_DB_CHECKS=1 node scripts/run-evals.mjs      (skip checks 3–5, no DB needed)
 */

import pg   from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildCanonicalText } from '../lib/ingest/evidence-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ───────────────────────────────────────────────────────────

try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

// ── Config ────────────────────────────────────────────────────────────────────

const BASE         = (process.env.ASK_URL ?? 'https://heyblu.ai') + '/api/ask-v2';
const EVAL_TIER    = process.env.EVAL_TIER    ?? null;
const EVAL_LEAGUE  = process.env.EVAL_LEAGUE  ?? null;
const TIMEOUT_MS   = parseInt(process.env.EVAL_TIMEOUT_MS ?? '45000', 10);
const SKIP_DB_CHECKS = process.env.SKIP_DB_CHECKS === '1';

const RAG_STATES = new Set(['answered', 'ruling']);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * POST to ask-v2 with a timeout.
 * Returns { status, body } or throws on network/timeout error.
 */
async function callAskV2(question, league) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, league }),
      signal:  ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns true when expectedRuleNumber is satisfied by the response.
 * Accepts exact match or prefix match (e.g. "505" matches "505.1", "505-a").
 */
function ruleNumberSatisfied(expected, citedRuleNumbers) {
  if (!expected) return true;
  if (!Array.isArray(citedRuleNumbers) || citedRuleNumbers.length === 0) return false;
  return citedRuleNumbers.some(n => {
    const cited = String(n).trim();
    const exp   = String(expected).trim();
    return cited === exp || cited.startsWith(exp + '.') || cited.startsWith(exp + '-');
  });
}

/**
 * Build canonical text for rule_node Evidence Bundles (mirrors retrieval layer).
 *
 * @param {import('pg').PoolClient} dbClient
 * @param {string[]} nodeIds — rule_node UUIDs (API retrieved_source_ids / bundle_ids)
 * @returns {Promise<Array<{ id: string, rule_number: string|null, canonical_text: string }>>}
 */
async function loadNodeCanonicalTexts(dbClient, nodeIds) {
  if (!nodeIds?.length) return [];

  const { rows: nodes } = await dbClient.query(`
    SELECT id, rule_number, title, body_text, node_type, rulebook_version_id
    FROM   rule_nodes
    WHERE  id = ANY($1::uuid[])
  `, [nodeIds]);

  const out = [];
  for (const node of nodes) {
    const { rows: children } = await dbClient.query(`
      SELECT node_type, title, body_text
      FROM   rule_nodes
      WHERE  parent_id = $1
        AND  node_type IN ('comment', 'exception', 'penalty')
      ORDER  BY sort_order ASC, created_at ASC
    `, [node.id]);

    const { rows: ancestors } = await dbClient.query(`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, node_type, rule_number, title, 0 AS depth
        FROM   rule_nodes WHERE id = $1
        UNION ALL
        SELECT rn.id, rn.parent_id, rn.node_type, rn.rule_number, rn.title, chain.depth + 1
        FROM   rule_nodes rn
        JOIN   chain ON rn.id = chain.parent_id
      )
      SELECT node_type, rule_number, title
      FROM   chain
      ORDER  BY depth DESC
    `, [node.id]);

    const ancestorPath = ancestors.slice(0, -1).map(a => {
      const num = a.rule_number ? `${a.rule_number}. ` : '';
      return `${a.node_type} ${num}${a.title ?? ''}`.trim();
    }).filter(Boolean).join(' → ');

    out.push({
      id:             node.id,
      rule_number:    node.rule_number,
      canonical_text: buildCanonicalText(node, ancestorPath, children),
    });
  }
  return out;
}

/**
 * Check 3: expected_source_text appears in a retrieved rule_node canonical text.
 */
async function checkExpectedSourceText(dbClient, bundleIds, expectedText) {
  if (!expectedText || !bundleIds?.length) return { ok: true, reason: null };
  try {
    const nodes  = await loadNodeCanonicalTexts(dbClient, bundleIds);
    const needle = expectedText.toLowerCase();
    const found  = nodes.some(n => n.canonical_text?.toLowerCase().includes(needle));
    if (found) return { ok: true, reason: null };
    return {
      ok:     false,
      reason: `CHECK3_BUNDLE_TEXT: "${expectedText}" not found in any of ${nodes.length} retrieved rule_node bundle(s)`,
    };
  } catch (err) {
    return { ok: false, reason: `CHECK3_BUNDLE_TEXT: DB query failed — ${err.message}` };
  }
}

/**
 * Check 4: all retrieved bundle IDs belong to the active rulebook version.
 */
async function checkVersionIsolation(dbClient, bundleIds, activeVersionId) {
  if (!bundleIds?.length || !activeVersionId) return { ok: true, reason: null };
  try {
    const { rows } = await dbClient.query(
      `SELECT id, rule_number
       FROM   rule_nodes
       WHERE  id = ANY($1::uuid[])
         AND  rulebook_version_id != $2::uuid`,
      [bundleIds, activeVersionId],
    );
    if (rows.length === 0) return { ok: true, reason: null };
    return {
      ok:     false,
      reason: `CHECK4_VERSION: ${rows.length} rule_node(s) belong to a different version than active_version_id="${activeVersionId}"`,
    };
  } catch (err) {
    return { ok: false, reason: `CHECK4_VERSION: DB query failed — ${err.message}` };
  }
}

/**
 * Check 5: every retrieved_source_id resolves to a valid rule_node with version linkage.
 */
async function checkValidRuleNodes(dbClient, bundleIds) {
  if (!bundleIds?.length) return { ok: true, reason: null };
  try {
    const { rows } = await dbClient.query(
      `SELECT id, rulebook_version_id
       FROM   rule_nodes
       WHERE  id = ANY($1::uuid[])`,
      [bundleIds],
    );
    const foundIds = new Set(rows.map(r => r.id));
    const missing  = bundleIds.filter(id => !foundIds.has(id));
    const nullVer  = rows.filter(r => !r.rulebook_version_id);

    if (missing.length > 0) {
      return {
        ok:     false,
        reason: `CHECK5_INVALID_NODE: ${missing.length} retrieved_source_id(s) are not valid rule_nodes`,
      };
    }
    if (nullVer.length > 0) {
      return {
        ok:     false,
        reason: `CHECK5_INVALID_NODE: ${nullVer.length} rule_node(s) have null rulebook_version_id`,
      };
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `CHECK5_INVALID_NODE: DB query failed — ${err.message}` };
  }
}

/**
 * Map a failure reason string to a triage category.
 *
 * @param {string} reason
 * @returns {string}
 */
function classifyFailure(reason) {
  if (reason.includes('unverifiable') || reason.startsWith('CHECK6_VERIFIER')) return 'Verifier blocked';
  if (reason.startsWith('CHECK1_STATE')) return 'Routing error';
  if (reason.startsWith('CHECK2_RULE')) return 'Wrong rule retrieved';
  if (reason.startsWith('CHECK3_BUNDLE_TEXT')) return 'Missing expected text in bundle';
  if (reason.startsWith('CHECK4_VERSION') || reason.startsWith('CHECK5_INVALID_NODE')) return 'Version isolation';
  if (reason.startsWith('CHECK6_VERIFIER_GATE')) return 'Verifier gate broken';
  if (reason.startsWith('CHECK7_NC')) return 'Interview structure error';
  if (reason.startsWith('Network/timeout')) return 'Network/timeout';
  return 'Other';
}

/**
 * Persist last_run_passed and last_run_at for one eval case.
 * Errors are logged but never fail the suite.
 */
async function persistResult(dbClient, id, passed) {
  await dbClient.query(
    `UPDATE eval_cases SET last_run_passed = $1, last_run_at = now() WHERE id = $2`,
    [passed, id],
  ).catch(err => console.warn(`  [warn] DB update failed for ${id}: ${err.message}`));
}

// ── Eval runner ───────────────────────────────────────────────────────────────

async function runEval(evalCase, dbClient) {
  const {
    id, league_slug, question, expected_state, expected_rule_number,
    expected_source_text, case_type, tier,
  } = evalCase;

  const label = `[${tier}] ${case_type}`;

  // ── API call ───────────────────────────────────────────────────────────────
  let status, body;
  try {
    ({ status, body } = await callAskV2(question, league_slug));
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'TIMEOUT' : err.message;
    console.error(`  ✗  ${label}\n       error: ${msg}`);
    await persistResult(dbClient, id, false);
    return { passed: false, label, failures: [`Network/timeout: ${msg}`] };
  }

  const failures = [];

  // ── Check 1: state matches ─────────────────────────────────────────────────
  const actualState = body.state ?? `HTTP ${status}`;
  if (actualState !== expected_state) {
    failures.push(
      `CHECK1_STATE: expected="${expected_state}" got="${actualState}"`,
    );
  }

  // ── Check 2: rule number present (when expected) ───────────────────────────
  if (!ruleNumberSatisfied(expected_rule_number, body.cited_rule_numbers)) {
    failures.push(
      `CHECK2_RULE: expected="${expected_rule_number}" cited=${JSON.stringify(body.cited_rule_numbers ?? [])}`,
    );
  }

  // ── Checks 3–5: Evidence Bundle / rule_node validation (RAG states only) ───
  const isRagState = RAG_STATES.has(body.state);
  const bundleIds  = isRagState ? (body.retrieved_source_ids ?? []) : [];

  if (isRagState && !SKIP_DB_CHECKS) {
    const c3 = await checkExpectedSourceText(dbClient, bundleIds, expected_source_text);
    if (!c3.ok) failures.push(c3.reason);

    const evidenceVersionId = body.usedFallback && body.fallback_version_id
      ? body.fallback_version_id
      : body.active_version_id;
    const c4 = await checkVersionIsolation(dbClient, bundleIds, evidenceVersionId);
    if (!c4.ok) failures.push(c4.reason);

    const c5 = await checkValidRuleNodes(dbClient, bundleIds);
    if (!c5.ok) failures.push(c5.reason);
  }

  // ── Check 6: unsupported verifier status never leaks a draft answer ────────
  //
  // Invariant: if the verifier returns status='unsupported' the gate must
  // block and set state='unverifiable'.  If verifier_status='unsupported'
  // appears in a non-unverifiable response the gate is broken.
  if (body.verifier_status === 'unsupported' && body.state !== 'unverifiable') {
    failures.push(
      `CHECK6_VERIFIER_GATE: verifier_status="unsupported" but state="${body.state}" — ` +
      `the fail-closed gate should have produced state="unverifiable"`,
    );
  }

  // ── Check 7: needs_clarification structural integrity ──────────────────────
  if (body.state === 'needs_clarification') {
    const q = body.current_question;

    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      failures.push('CHECK7_NC: current_question is missing or not an object');
    } else {
      if (!q.id || typeof q.id !== 'string') {
        failures.push('CHECK7_NC: current_question.id missing or not a string');
      }
      if (!q.text || typeof q.text !== 'string') {
        failures.push('CHECK7_NC: current_question.text missing or not a string');
      }
      if (q.type !== 'binary' && q.type !== 'select') {
        failures.push(`CHECK7_NC: current_question.type="${q.type}" — must be "binary" or "select"`);
      }
      if (!Array.isArray(q.options) || q.options.length === 0) {
        failures.push('CHECK7_NC: current_question.options missing or empty');
      }
    }

    const p = body.progress;
    if (!p || typeof p.answered !== 'number') {
      failures.push('CHECK7_NC: progress.answered missing or not a number');
    }
    if (!p || typeof p.remaining_estimated !== 'number') {
      failures.push('CHECK7_NC: progress.remaining_estimated missing or not a number');
    }
  }

  // ── Persist + print ────────────────────────────────────────────────────────
  const passed = failures.length === 0;
  await persistResult(dbClient, id, passed);

  if (passed) {
    const ruleNote = expected_rule_number ? `  rule=${expected_rule_number} ✓` : '';
    console.log(`  ✓  ${label}  (state=${actualState}${ruleNote})`);
  } else {
    console.error(`  ✗  ${label}  (state=${actualState})`);
    for (const f of failures) console.error(`       ${f}`);
    if (process.env.EVAL_DEBUG === '1') {
      console.error('       Full response:', JSON.stringify(body, null, 2).slice(0, 1000));
    }
  }

  return { passed, label, failures };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n━━━  BLU Critical Eval Suite  ━━━');
console.log(`Target  : ${BASE}`);
if (EVAL_TIER)      console.log(`Filter  : tier = ${EVAL_TIER}`);
if (EVAL_LEAGUE)    console.log(`Filter  : league = ${EVAL_LEAGUE}`);
if (SKIP_DB_CHECKS) console.log(`Mode    : SKIP_DB_CHECKS=1 (checks 3–5 skipped)`);
console.log('');

// ── Load eval cases from DB ───────────────────────────────────────────────────

const conditions = [];
const params     = [];

if (EVAL_TIER) {
  params.push(EVAL_TIER);
  conditions.push(`tier = $${params.length}`);
}
if (EVAL_LEAGUE) {
  params.push(EVAL_LEAGUE);
  conditions.push(`league_slug = $${params.length}`);
}

const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

const dbClient = await pool.connect();
let rows;
try {
  const res = await dbClient.query(
    `SELECT id, league_slug, question, expected_state, expected_rule_number,
            expected_source_text, case_type, tier
     FROM   eval_cases ${whereClause}
     ORDER  BY tier DESC, created_at ASC`,
    params,
  );
  rows = res.rows;
} catch (err) {
  console.error('Failed to load eval cases:', err.message);
  dbClient.release();
  await pool.end();
  process.exit(1);
}

if (rows.length === 0) {
  console.log('No eval cases found. Run: node scripts/seed-evals.mjs');
  dbClient.release();
  await pool.end();
  process.exit(0);
}

console.log(`Loaded ${rows.length} eval case(s).\n`);

// ── Run — sequential by tier (critical first) ─────────────────────────────────

const byCritical = rows.filter(r => r.tier === 'critical');
const byBroad    = rows.filter(r => r.tier !== 'critical');
const results    = [];

if (byCritical.length > 0) {
  console.log('── Critical tier ────────────────────────────────');
  for (const c of byCritical) {
    results.push(await runEval(c, dbClient));
  }
}

if (byBroad.length > 0) {
  console.log('\n── Broad tier ───────────────────────────────────');
  for (const c of byBroad) {
    results.push(await runEval(c, dbClient));
  }
}

dbClient.release();
await pool.end();

// ── Summary ───────────────────────────────────────────────────────────────────

const critResults    = results.slice(0, byCritical.length);
const critPassed     = critResults.filter(r => r.passed).length;
const totalPassed    = results.filter(r => r.passed).length;
const totalFailed    = results.filter(r => !r.passed).length;

console.log('\n' + '─'.repeat(60));
console.log(`Critical : ${critPassed}/${byCritical.length} passed`);
console.log(`Overall  : ${totalPassed}/${results.length} passed   (${totalFailed} failed)`);
console.log('─'.repeat(60) + '\n');

if (totalFailed > 0) {
  console.error('Failed cases:');
  const grouped = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.passed) continue;
    console.error(`  • ${r.label}`);
    for (const f of r.failures ?? []) {
      console.error(`      ${f}`);
      const cat = classifyFailure(f);
      grouped[cat] = grouped[cat] ?? [];
      grouped[cat].push({ label: r.label, reason: f });
    }
  }

  console.error('\nFailure summary by category:');
  for (const [cat, items] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${cat}: ${items.length}`);
    for (const item of items.slice(0, 5)) {
      console.error(`    - ${item.label}`);
    }
    if (items.length > 5) console.error(`    … +${items.length - 5} more`);
  }
  console.error('');
  process.exit(1);
}
