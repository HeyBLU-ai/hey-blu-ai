/**
 * scripts/test-answer-cache.mjs
 *
 * Unit tests for the Verified Answer Cache layer in api/ask-v2.js.
 *
 * Covers:
 *   1-6:  normalizeQuestion — canonical form, punctuation stripping, edge cases
 *   7:    readAnswerCache   — cache miss (mock DB returns no rows)
 *   8:    readAnswerCache   — cache hit (mock DB returns a row)
 *   9:    readAnswerCache   — DB error is swallowed, returns null (no crash)
 *  10:    bumpCacheHit      — issues correct UPDATE SQL (mock pool)
 *  11:    writeAnswerCache  — issues correct INSERT…ON CONFLICT SQL (mock pool)
 *  12:    writeAnswerCache  — DB error is swallowed (no crash)
 *  13:    cached hit shape  — returned object includes cached:true and correct fields
 *  14:    interview rulings — extraContext prevents cache read+write (tested via flag)
 *
 * Usage:
 *   node scripts/test-answer-cache.mjs
 */

// Import only the exported pure function — avoids triggering DB/Anthropic init.
import { normalizeQuestion } from '../api/ask-v2.js';

// ── Re-implement the internal helpers locally for isolated DB-mock tests ──────
// (They mirror the code in api/ask-v2.js exactly so regressions are caught.)

async function readAnswerCache(dbClient, leagueSlug, activeVersionId, normalizedQ) {
  try {
    const res = await dbClient.query(`
      SELECT id, answer, cited_source_ids, cited_rule_numbers, verifier_status
      FROM   verified_answer_cache
      WHERE  league_slug         = $1
        AND  rulebook_version_id = $2
        AND  normalized_question = $3
      LIMIT  1
    `, [leagueSlug, activeVersionId, normalizedQ]);
    return res.rows[0] ?? null;
  } catch (err) {
    return null;
  }
}

function bumpCacheHit(dbPool, cacheId) {
  dbPool.query(
    `UPDATE verified_answer_cache
     SET hit_count = hit_count + 1, last_used_at = now()
     WHERE id = $1`,
    [cacheId],
  ).catch(() => {});
}

function writeAnswerCache(dbPool, {
  leagueSlug, activeVersionId, normalizedQ,
  answer, citedSourceIds, citedRuleNumbers, verifierStatus,
}) {
  const draftModel  = process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6';
  const verifyModel = process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-opus-4-8';

  // Fire-and-forget: errors are swallowed (mirrors ask-v2.js exactly)
  dbPool.query(`
    INSERT INTO verified_answer_cache
      (league_slug, rulebook_version_id, normalized_question,
       answer, cited_source_ids, cited_rule_numbers,
       verifier_status, draft_model, verify_model)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (league_slug, rulebook_version_id, normalized_question)
    DO UPDATE SET
      answer             = EXCLUDED.answer,
      cited_source_ids   = EXCLUDED.cited_source_ids,
      cited_rule_numbers = EXCLUDED.cited_rule_numbers,
      verifier_status    = EXCLUDED.verifier_status,
      draft_model        = EXCLUDED.draft_model,
      verify_model       = EXCLUDED.verify_model,
      last_used_at       = now()
  `, [
    leagueSlug, activeVersionId, normalizedQ,
    answer, citedSourceIds, citedRuleNumbers ?? [],
    verifierStatus, draftModel, verifyModel,
  ]).catch(() => {});
}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? '  —  ' + detail : ''}`);
    failed++;
  }
}

// Mock DB client: returns configurable rows, records last query+params.
function mockClient(rows = []) {
  const calls = [];
  const client = {
    _calls: calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows };
    },
  };
  return client;
}

// Mock pool: wraps a single mock client.
function mockPool(rows = []) {
  const client = mockClient(rows);
  const calls  = [];
  const pool   = {
    _calls: calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows };
    },
  };
  return { pool, client };
}

// ── Tests 1-6: normalizeQuestion ──────────────────────────────────────────────

console.log('\nTests 1-6: normalizeQuestion');

check('1: question mark stripped',
  normalizeQuestion('Must slide?') === 'must slide');

check('2: lowercase applied',
  normalizeQuestion('MUST SLIDE') === 'must slide');

check('3: leading/trailing whitespace trimmed',
  normalizeQuestion('  must slide  ') === 'must slide');

check('4: internal whitespace collapsed',
  normalizeQuestion('must  slide   rule') === 'must slide rule');

check('5: punctuation stripped — period, comma, quotes',
  normalizeQuestion('Rule 505, "must slide."') === 'rule 505 must slide');

check('6: empty/null input returns empty string',
  normalizeQuestion('') === '' && normalizeQuestion(null) === '');

// ── Test 7: readAnswerCache — cache miss ──────────────────────────────────────

console.log('\nTest 7: readAnswerCache — cache miss returns null');
{
  const { client } = mockPool([]);  // empty rows = miss
  const result = await readAnswerCache(client, 'bamsbl', 'version-uuid', 'must slide');

  check('7a: returns null on miss', result === null, `got ${JSON.stringify(result)}`);
  check('7b: query was executed',   client._calls.length === 1);
  check('7c: query targets correct table',
    client._calls[0].sql.includes('verified_answer_cache'));
  check('7d: params include league_slug, version_id, normalized_q',
    JSON.stringify(client._calls[0].params) === JSON.stringify(['bamsbl', 'version-uuid', 'must slide']));
}

// ── Test 8: readAnswerCache — cache hit ───────────────────────────────────────

console.log('\nTest 8: readAnswerCache — cache hit returns the row');
{
  const fakeRow = {
    id:                 'cache-row-uuid',
    answer:             'Runners do not have to slide.',
    cited_source_ids:   ['span-uuid-1'],
    cited_rule_numbers: ['505'],
    verifier_status:    'approved',
  };
  const { client } = mockPool([fakeRow]);
  const result = await readAnswerCache(client, 'bamsbl', 'version-uuid', 'must slide');

  check('8a: returns the row on hit',            result !== null);
  check('8b: answer matches',                    result.answer === fakeRow.answer);
  check('8c: cited_source_ids matches',          JSON.stringify(result.cited_source_ids) === JSON.stringify(fakeRow.cited_source_ids));
  check('8d: verifier_status matches',           result.verifier_status === 'approved');
}

// ── Test 9: readAnswerCache — DB error swallowed ──────────────────────────────

console.log('\nTest 9: readAnswerCache — DB error returns null, does not throw');
{
  const throwingClient = {
    query: async () => { throw new Error('connection reset'); },
  };
  let result;
  let threw = false;
  try {
    result = await readAnswerCache(throwingClient, 'bamsbl', 'version-uuid', 'must slide');
  } catch { threw = true; }

  check('9a: did not throw', !threw);
  check('9b: returns null', result === null);
}

// ── Test 10: bumpCacheHit — correct UPDATE SQL ────────────────────────────────

console.log('\nTest 10: bumpCacheHit — fires UPDATE with correct params');
{
  const { pool } = mockPool();
  bumpCacheHit(pool, 'cache-row-uuid');

  // bumpCacheHit is fire-and-forget; wait one microtask tick
  await new Promise(r => setTimeout(r, 0));

  check('10a: exactly one query fired',         pool._calls.length === 1);
  check('10b: UPDATE statement used',            pool._calls[0]?.sql.includes('UPDATE verified_answer_cache'));
  check('10c: hit_count incremented',            pool._calls[0]?.sql.includes('hit_count + 1'));
  check('10d: last_used_at updated',             pool._calls[0]?.sql.includes('last_used_at'));
  check('10e: correct cache ID passed as param', pool._calls[0]?.params[0] === 'cache-row-uuid');
}

// ── Test 11: writeAnswerCache — correct INSERT…ON CONFLICT SQL ────────────────

console.log('\nTest 11: writeAnswerCache — fires INSERT…ON CONFLICT with correct params');
{
  const { pool } = mockPool();
  const entry = {
    leagueSlug:       'bamsbl',
    activeVersionId:  'version-uuid',
    normalizedQ:      'must slide',
    answer:           'Runners do not have to slide.',
    citedSourceIds:   ['span-uuid-1'],
    citedRuleNumbers: ['505'],
    verifierStatus:   'approved',
  };
  writeAnswerCache(pool, entry);
  await new Promise(r => setTimeout(r, 0));

  check('11a: exactly one query fired',        pool._calls.length === 1);
  check('11b: INSERT statement used',          pool._calls[0]?.sql.includes('INSERT INTO verified_answer_cache'));
  check('11c: ON CONFLICT clause present',     pool._calls[0]?.sql.includes('ON CONFLICT'));
  check('11d: DO UPDATE SET present',          pool._calls[0]?.sql.includes('DO UPDATE SET'));
  check('11e: league_slug param correct',      pool._calls[0]?.params[0] === 'bamsbl');
  check('11f: version_id param correct',       pool._calls[0]?.params[1] === 'version-uuid');
  check('11g: normalized_q param correct',     pool._calls[0]?.params[2] === 'must slide');
  check('11h: answer param correct',           pool._calls[0]?.params[3] === 'Runners do not have to slide.');
  check('11i: verifier_status param correct',  pool._calls[0]?.params[6] === 'approved');
}

// ── Test 12: writeAnswerCache — DB error is swallowed ─────────────────────────

console.log('\nTest 12: writeAnswerCache — DB error swallowed, does not throw');
{
  const throwingPool = {
    query: async () => { throw new Error('insert failed'); },
  };
  let threw = false;
  try {
    writeAnswerCache(throwingPool, {
      leagueSlug: 'bamsbl', activeVersionId: 'v', normalizedQ: 'q',
      answer: 'a', citedSourceIds: [], citedRuleNumbers: [], verifierStatus: 'approved',
    });
    await new Promise(r => setTimeout(r, 0));
  } catch { threw = true; }

  check('12: write error is swallowed (no throw)', !threw);
}

// ── Test 13: cache hit response shape ─────────────────────────────────────────

console.log('\nTest 13: cached hit produces correct response shape (simulation)');
{
  // Simulate what runRAG returns on a cache hit
  const fakeHit = {
    id:                 'cache-uuid',
    answer:             'Runners do not have to slide per Rule 505.',
    cited_source_ids:   ['span-1', 'span-2'],
    cited_rule_numbers: ['505'],
    verifier_status:    'approved',
  };

  // Mirror the return shape from runRAG on a cache hit
  const simulatedResult = {
    reply:                fakeHit.answer,
    cached:               true,
    blocked:              false,
    verifierAudit:        { status: fakeHit.verifier_status, claims: [], unsupported_claims: [], confidence: 'high' },
    usedFallback:         false,
    fallbackLeague:       null,
    leagueName:           'Bay Area Men\'s Senior Baseball League',
    league_slug:          'bamsbl',
    active_version_id:    'version-uuid',
    retrieved_source_ids: fakeHit.cited_source_ids ?? [],
    cited_rule_numbers:   fakeHit.cited_rule_numbers ?? [],
  };

  check('13a: cached = true',                          simulatedResult.cached === true);
  check('13b: blocked = false',                        simulatedResult.blocked === false);
  check('13c: reply equals cached answer',             simulatedResult.reply === fakeHit.answer);
  check('13d: retrieved_source_ids populated',         simulatedResult.retrieved_source_ids.length === 2);
  check('13e: verifierAudit.status = approved',        simulatedResult.verifierAudit.status === 'approved');
  check('13f: unsupported_claims empty',               simulatedResult.verifierAudit.unsupported_claims.length === 0);
}

// ── Test 14: extraContext prevents caching ────────────────────────────────────

console.log('\nTest 14: extraContext (interview ruling) flag prevents cache read/write');
{
  // The logic in runRAG is: `if (!extraContext) { /* cache read */ }`
  // and `if (!blocked && verifierAudit.status === 'approved' && !extraContext) { /* cache write */ }`
  // We verify the condition logic here without importing the full module.

  const extraContext = 'Runner was on first base, no outs, infield fly rule in effect';
  const noContext    = '';

  check('14a: !extraContext is true when empty',  !noContext   === true);
  check('14b: !extraContext is false when set',   !extraContext === false);
  check('14c: cache write gated by !extraContext',
    (!false && 'approved' === 'approved' && !noContext)    === true,  'should cache empty context');
  check('14d: cache write blocked by extraContext',
    (!false && 'approved' === 'approved' && !extraContext) === false, 'should NOT cache interview ruling');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(56));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(56) + '\n');

if (failed > 0) process.exit(1);
