/**
 * Direct handler test for /api/ask-v2.
 *
 * Loads .env.local, then calls the handler with mock req/res objects —
 * no HTTP server needed. Simulates exactly what Vercel would do.
 *
 * Run with:  node api/test-endpoint.mjs
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ──────────────────────────────────────────────────────────

try {
  const envPath    = resolve(__dirname, '../.env.local');
  const envContent = await readFile(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('✓ Loaded .env.local\n');
} catch {
  console.error('✗ Could not load .env.local — run: vercel env pull .env.local');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('✗ OPENAI_API_KEY not found in .env.local');
  process.exit(1);
}
console.log(`✓ OPENAI_API_KEY present (${process.env.OPENAI_API_KEY.slice(0, 8)}…)\n`);

// ── Import handler (after env is set) ───────────────────────────────────────

const { default: handler } = await import('./ask-v2.js');

// ── Mock req / res ────────────────────────────────────────────────────────────

function makeReq(body) {
  return {
    method:  'POST',
    headers: { origin: 'https://heyblu.ai', 'content-type': 'application/json' },
    body,
  };
}

function makeRes() {
  const res = {
    _status:  null,
    _headers: {},
    _body:    null,
    setHeader(k, v) { this._headers[k] = v; },
    status(code)    { this._status = code; return this; },
    json(data)      { this._body = data; return this; },
    end()           { return this; },
  };
  return res;
}

// ── Run a single test ─────────────────────────────────────────────────────────

async function runTest(label, body) {
  console.log(`${'═'.repeat(64)}`);
  console.log(`  ${label}`);
  console.log(`${'─'.repeat(64)}`);
  console.log(`  Request: ${JSON.stringify(body)}\n`);

  const req = makeReq(body);
  const res = makeRes();

  const start = Date.now();
  await handler(req, res);
  const elapsed = Date.now() - start;

  console.log(`  HTTP status : ${res._status}`);
  console.log(`  Elapsed     : ${elapsed}ms`);
  console.log(`  Response:`);
  console.log(JSON.stringify(res._body, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
  console.log();

  return res._body;
}

// ── TEST 1 — Factual question (should return State A: "answered") ─────────────

console.log('\n  *** Starting tests — expect ~2s per request (OpenAI calls) ***\n');

const t1 = await runTest(
  'TEST 1 · Factual question → expect state: "answered"',
  { question: 'How far apart are the bases in Little League?', league: 'little league' },
);

const t1Pass = t1?.state === 'answered' && typeof t1?.reply === 'string';
console.log(t1Pass
  ? '  ✓ PASS — state is "answered" and reply is present\n'
  : `  ✗ FAIL — got state: "${t1?.state}"\n`);

// ── TEST 2 — Judgment question (should return State B: "needs_clarification") ─

const t2 = await runTest(
  'TEST 2 · Judgment question → expect state: "needs_clarification"',
  { question: 'Runner from second ran into the shortstop, what is the call?', league: 'little league' },
);

const t2Pass = t2?.state === 'needs_clarification' && t2?.matrix_id === 'runner_fielder_collision';
console.log(t2Pass
  ? '  ✓ PASS — state is "needs_clarification" with correct matrix\n'
  : `  ✗ FAIL — got state: "${t2?.state}", matrix_id: "${t2?.matrix_id}"\n`);

// ── TEST 3 — Interview follow-up (answer Q1, expect Q2) ──────────────────────

if (t2?.current_question?.id) {
  const firstQId = t2.current_question.id;

  const t3 = await runTest(
    `TEST 3 · Interview answer Q1 ("${firstQId}" = "yes") → expect next question`,
    {
      question:     'Runner from second ran into the shortstop, what is the call?',
      league:       'little league',
      matrix_state: { matrix_id: 'runner_fielder_collision', answers: { [firstQId]: 'yes' } },
    },
  );

  const t3Pass = t3?.state === 'needs_clarification' && t3?.current_question?.id !== firstQId;
  console.log(t3Pass
    ? `  ✓ PASS — advanced to next question: "${t3.current_question?.id}"\n`
    : `  ✗ FAIL — got state: "${t3?.state}", question: "${t3?.current_question?.id}"\n`);

  // ── TEST 4 — Complete the interview → expect a ruling (State C) ────────────

  const t4 = await runTest(
    'TEST 4 · Complete interview (all answers in) → expect state: "ruling"',
    {
      question:     'Runner from second ran into the shortstop, what is the call?',
      league:       'little league',
      matrix_state: {
        matrix_id: 'runner_fielder_collision',
        answers:   {
          fielder_had_possession: 'yes',
          runner_deviated:        'yes',
        },
      },
    },
  );

  const t4Pass = t4?.state === 'ruling' && typeof t4?.reply === 'string';
  console.log(t4Pass
    ? '  ✓ PASS — state is "ruling" and reply contains the ruling\n'
    : `  ✗ FAIL — got state: "${t4?.state}"\n`);
}

// ── TEST 5 — Descriptive obstruction (no keyword → classifier catches it) ─────

const t5 = await runTest(
  'TEST 5 · Descriptive obstruction (no keyword) → expect State B via classifier',
  {
    question: 'The base stealer slides well before the base because the infielder is standing in front of it. The runner comes to a full stop at the fielder\'s feet not reaching the base. The catcher\'s throw arrives and the fielder tags the runner. What is the call?',
    league: 'bamsbl',
  },
);

const t5Pass = t5?.state === 'needs_clarification';
console.log(t5Pass
  ? `  ✓ PASS — classifier caught the obstruction play (matrix: ${t5?.matrix_id})\n`
  : `  ✗ FAIL — got state: "${t5?.state}" (should have triggered interview)\n`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`${'═'.repeat(64)}`);
console.log('  Tests complete.');
console.log(`${'═'.repeat(64)}\n`);
