/**
 * scripts/run-evals.mjs
 *
 * Runs the Critical Eval Suite against a live ask-v2 endpoint.
 *
 * For each eval_case row it:
 *   1. POSTs the question to /api/ask-v2
 *   2. Asserts response.state === expected_state
 *   3. If expected_rule_number is set, asserts it appears in cited_rule_numbers
 *   4. UPDATEs last_run_passed + last_run_at in the DB
 *   5. Prints a per-case result line and a final summary
 *
 * Usage:
 *   node scripts/run-evals.mjs
 *   ASK_URL=http://localhost:3000 node scripts/run-evals.mjs
 *   EVAL_TIER=critical node scripts/run-evals.mjs   (only critical cases)
 *   EVAL_LEAGUE=bamsbl node scripts/run-evals.mjs   (only one league)
 *   CONCURRENCY=3 node scripts/run-evals.mjs         (default 1 — sequential)
 *
 * Exit codes:
 *   0 — all evals passed
 *   1 — one or more evals failed, or a setup error occurred
 */

import pg   from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

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

const BASE        = (process.env.ASK_URL ?? 'https://heyblu.ai') + '/api/ask-v2';
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY ?? '1', 10));
const EVAL_TIER   = process.env.EVAL_TIER   ?? null;  // filter by tier if set
const EVAL_LEAGUE = process.env.EVAL_LEAGUE ?? null;  // filter by league if set
const TIMEOUT_MS  = parseInt(process.env.EVAL_TIMEOUT_MS ?? '45000', 10);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * POST to ask-v2 with a timeout.
 * Returns { status, body } or throws on network error / timeout.
 */
async function callAskV2(question, league) {
  const ctrl = new AbortController();
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
 * Check whether expectedRuleNumber is satisfied by the response.
 * Accepts:
 *   - exact match against any element in citedRuleNumbers
 *   - prefix match (e.g. expected "505" matches cited "505.1")
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
 * Update last_run_passed and last_run_at for one eval case.
 * Errors are logged but do not fail the suite.
 */
async function persistResult(client, id, passed) {
  await client.query(
    `UPDATE eval_cases SET last_run_passed = $1, last_run_at = now() WHERE id = $2`,
    [passed, id],
  ).catch(err => console.warn(`  [warn] DB update failed for ${id}: ${err.message}`));
}

// ── Eval runner ───────────────────────────────────────────────────────────────

async function runEval(evalCase, dbClient) {
  const { id, league_slug, question, expected_state, expected_rule_number, case_type, tier } = evalCase;
  const label = `[${tier}] ${case_type}`;

  let status, body;
  try {
    ({ status, body } = await callAskV2(question, league_slug));
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'TIMEOUT' : err.message;
    console.error(`  ✗  ${label}\n       error: ${msg}`);
    await persistResult(dbClient, id, false);
    return { passed: false, label, reason: msg };
  }

  // ── Assertion 1: state matches ─────────────────────────────────────────────
  const actualState = body.state ?? `HTTP ${status}`;
  const stateOk     = actualState === expected_state;

  // ── Assertion 2: rule number present (if expected) ─────────────────────────
  const ruleOk = ruleNumberSatisfied(expected_rule_number, body.cited_rule_numbers);

  const passed = stateOk && ruleOk;

  // ── Persist to DB ──────────────────────────────────────────────────────────
  await persistResult(dbClient, id, passed);

  // ── Print result ───────────────────────────────────────────────────────────
  if (passed) {
    const ruleNote = expected_rule_number ? `  rule=${expected_rule_number} ✓` : '';
    console.log(`  ✓  ${label}  (state=${actualState}${ruleNote})`);
  } else {
    const reasons = [];
    if (!stateOk) reasons.push(`state: expected="${expected_state}" got="${actualState}"`);
    if (!ruleOk)  reasons.push(`rule_number: expected="${expected_rule_number}" cited=${JSON.stringify(body.cited_rule_numbers ?? [])}`);
    console.error(`  ✗  ${label}`);
    for (const r of reasons) console.error(`       ${r}`);
    if (process.env.EVAL_DEBUG === '1') {
      console.error('       Full response:', JSON.stringify(body, null, 2).slice(0, 800));
    }
  }

  return { passed, label };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n━━━  BLU Critical Eval Suite  ━━━');
console.log(`Target : ${BASE}`);
if (EVAL_TIER)   console.log(`Filter : tier = ${EVAL_TIER}`);
if (EVAL_LEAGUE) console.log(`Filter : league = ${EVAL_LEAGUE}`);
console.log('');

// ── Load eval cases ────────────────────────────────────────────────────────────

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
    `SELECT * FROM eval_cases ${whereClause} ORDER BY tier DESC, created_at ASC`,
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

// ── Group by tier for display ──────────────────────────────────────────────────

const byCritical = rows.filter(r => r.tier === 'critical');
const byBroad    = rows.filter(r => r.tier !== 'critical');

// ── Run sequentially (CONCURRENCY=1 default) ──────────────────────────────────
// Sequential is safer: verifier LLM calls are expensive, and we don't want to
// saturate the Anthropic rate limits.

const results = [];

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

const totalPassed  = results.filter(r => r.passed).length;
const totalFailed  = results.filter(r => !r.passed).length;
const critPassed   = results.filter((r, i) => rows[i]?.tier === 'critical' && r.passed).length;
const critTotal    = byCritical.length;

console.log('\n' + '─'.repeat(56));
console.log(`Critical:  ${critPassed}/${critTotal} passed`);
console.log(`Overall :  ${totalPassed}/${results.length} passed   (${totalFailed} failed)`);
console.log('─'.repeat(56) + '\n');

if (totalFailed > 0) {
  console.log('Failed cases:');
  results.filter(r => !r.passed).forEach(r => console.log(`  • ${r.label}: ${r.reason ?? 'assertion failed'}`));
  console.log('');
  process.exit(1);
}
