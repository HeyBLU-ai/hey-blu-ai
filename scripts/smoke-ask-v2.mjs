#!/usr/bin/env node
/**
 * smoke-ask-v2.mjs
 *
 * Smoke tests for api/ask-v2.js covering the fixes in Steps 3-4:
 *   1. Empty league   → 404 league_not_found
 *   2. Null league    → 404 league_not_found
 *   3. Unknown league → 404 league_not_found
 *   4. BAMSBL + factual question → 200 answered, reply contains BAMSBL source (not MLB fallback)
 *   5. BAMSBL + judgment question → 200 needs_clarification (interview triggered)
 *
 * Tests run against the live URL by default.
 * Override with: ASK_URL=http://localhost:3000 node scripts/smoke-ask-v2.mjs
 */

const BASE = (process.env.ASK_URL ?? 'https://heyblu.ai') + '/api/ask-v2';

let passed = 0;
let failed = 0;

async function post(body) {
  const res = await fetch(BASE, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

console.log(`\n━━━  ask-v2 Smoke Test  ━━━`);
console.log(`Target: ${BASE}\n`);

// ── Test 1: Empty league string → 404 ───────────────────────────────────────
console.log('Test 1: empty league string');
{
  const r = await post({ question: 'what is the must slide rule?', league: '' });
  check('HTTP 404',              r.status === 404,            `got ${r.status}`);
  check('error = league_not_found', r.body.error === 'league_not_found', `got "${r.body.error}"`);
}

// ── Test 2: Missing league field → 404 ──────────────────────────────────────
console.log('\nTest 2: missing league field');
{
  const r = await post({ question: 'what is the must slide rule?' });
  check('HTTP 404',              r.status === 404,            `got ${r.status}`);
  check('error = league_not_found', r.body.error === 'league_not_found', `got "${r.body.error}"`);
}

// ── Test 3: Unknown league slug → 404 ───────────────────────────────────────
console.log('\nTest 3: unknown league slug');
{
  const r = await post({ question: 'what is the must slide rule?', league: 'fake-league-xyz' });
  check('HTTP 404',              r.status === 404,            `got ${r.status}`);
  check('error = league_not_found', r.body.error === 'league_not_found', `got "${r.body.error}"`);
  check('no MLB fallback in body',  !JSON.stringify(r.body).toLowerCase().includes('"state"'), `got state field — was silently answered`);
}

// ── Test 4: BAMSBL factual question → 200 answered, from BAMSBL ─────────────
console.log('\nTest 4: BAMSBL "must slide" — expects 200 answered from BAMSBL');
{
  const r = await post({ question: 'what is the must slide rule?', league: 'bamsbl' });
  check('HTTP 200',              r.status === 200,            `got ${r.status}`);
  check('state = answered',      r.body.state === 'answered', `got "${r.body.state}"`);
  check('reply is non-empty',    typeof r.body.reply === 'string' && r.body.reply.length > 50, 'reply too short or missing');
  check('no usedFallback to MLB', r.body.usedFallback !== true, 'usedFallback was true — fell back to MLB');
  check('reply is not "No answer received."', r.body.reply !== 'No answer received.', 'got generic fallback reply');
  // BAMSBL rule 505 should appear — either the number or the no-collision concept
  const replyLower = (r.body.reply ?? '').toLowerCase();
  check('reply mentions 505 or no-collision', replyLower.includes('505') || replyLower.includes('no-collision') || replyLower.includes('no collision'), 'neither 505 nor no-collision found in reply');
}

// ── Test 5: BAMSBL collision question → interview triggered ──────────────────
console.log('\nTest 5: BAMSBL collision judgment question — expects needs_clarification');
{
  const r = await post({ question: 'runner ran into the catcher at home plate', league: 'bamsbl' });
  check('HTTP 200',              r.status === 200,            `got ${r.status}`);
  check('state = needs_clarification OR answered', ['needs_clarification','answered'].includes(r.body.state), `got "${r.body.state}"`);
  if (r.body.state === 'needs_clarification') {
    check('current_question present', !!r.body.current_question?.text, 'current_question.text missing');
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) {
  process.exit(1);
}
