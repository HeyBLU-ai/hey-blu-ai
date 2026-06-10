/**
 * Offline test for the Judgment Matrix routing logic.
 *
 * Tests three things:
 *   1. prescreenForMatrix  — keyword trigger detection (no API call)
 *   2. getNextQuestion     — conditional interview branching
 *   3. buildRulingContext  — plain-English context assembly for the RAG prompt
 *
 * Run with:  node api/test-matrices.mjs
 * Requires:  Node 18+, no environment variables needed.
 */

import {
  JUDGMENT_MATRICES,
  findMatrix,
  prescreenForMatrix,
  getNextQuestion,
  buildRulingContext,
} from './judgment-matrices.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? `  →  ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── Test 1: State A — Factual questions should NOT trigger a matrix ──────────

section('TEST 1 · Factual questions (expect: null — no matrix triggered)');

const factualQuestions = [
  'How far apart are the bases in Little League?',
  'What is the distance from the pitcher\'s mound to home plate?',
  'How many pitches can an 11-year-old throw in a day?',
  'What is the height of the pitching mound in MLB?',
  'How many players can be on the field at one time?',
  'What is the definition of a balk?',
  'What size baseball is used in Little League?',
];

for (const q of factualQuestions) {
  const match = prescreenForMatrix(q);
  assert(`"${q.slice(0, 55)}…"`, match === null, match ? `WRONGLY triggered: ${match.id}` : '');
}

// ── Test 2: State B — Judgment questions SHOULD trigger the correct matrix ───

section('TEST 2 · Judgment questions (expect: specific matrix triggered)');

const judgmentQuestions = [
  {
    question: 'Runner from second ran into the shortstop, what is the call?',
    expected: 'runner_fielder_collision',
  },
  {
    question: 'The catcher blocked home plate and the runner crashed into him — obstruction or not?',
    expected: 'runner_fielder_collision',
  },
  {
    question: 'Does the infield fly rule apply here? Runners on first and second, one out, high popup to third baseman.',
    expected: 'infield_fly_rule',
  },
  {
    question: 'The catcher dropped the third strike — can the batter run to first?',
    expected: 'dropped_third_strike',
  },
  {
    question: 'Batter started to swing and the pitch hit him in the hand — HBP or strike?',
    expected: 'check_swing_hbp',
  },
  {
    question: 'Ball hit down the first base line, spun fair, then rolled foul — fair or foul?',
    expected: 'fair_foul_ball',
  },
  {
    question: 'Can the defense still appeal that the runner missed second base?',
    expected: 'appeal_play',
  },
  {
    question: 'Does the first baseman need to tag the runner or just touch the bag?',
    expected: 'force_vs_tag',
  },
];

for (const { question, expected } of judgmentQuestions) {
  const match = prescreenForMatrix(question);
  assert(
    `"${question.slice(0, 55)}…"  →  ${expected}`,
    match?.id === expected,
    match ? `got: ${match.id}` : 'got: null (no matrix triggered)',
  );
}

// ── Test 3: getNextQuestion — interview branching ────────────────────────────

section('TEST 3 · runner_fielder_collision — interview question sequencing');

const collisionMatrix = findMatrix('runner_fielder_collision');
assert('findMatrix() returns the collision matrix', collisionMatrix !== null);

// Empty answers → first question (fielder_had_possession)
const q1 = getNextQuestion(collisionMatrix, {});
assert(
  'No answers → first question is "fielder_had_possession"',
  q1?.id === 'fielder_had_possession',
  `got: ${q1?.id}`,
);

// Answered "yes" to fielder_had_possession → next should be "runner_deviated"
const q2_yes = getNextQuestion(collisionMatrix, { fielder_had_possession: 'yes' });
assert(
  'fielder_had_possession=yes → next question is "runner_deviated"',
  q2_yes?.id === 'runner_deviated',
  `got: ${q2_yes?.id}`,
);

// Answered "no" to fielder_had_possession → next should be "fielder_blocking_path"
const q2_no = getNextQuestion(collisionMatrix, { fielder_had_possession: 'no' });
assert(
  'fielder_had_possession=no → next question is "fielder_blocking_path"',
  q2_no?.id === 'fielder_blocking_path',
  `got: ${q2_no?.id}`,
);

// All "yes" branch answered → interview complete
const complete_yes = getNextQuestion(collisionMatrix, {
  fielder_had_possession: 'yes',
  runner_deviated:        'yes',
});
assert(
  'All yes-branch questions answered → getNextQuestion returns null (complete)',
  complete_yes === null,
  `got: ${complete_yes?.id}`,
);

// All "no" branch answered → interview complete
const complete_no = getNextQuestion(collisionMatrix, {
  fielder_had_possession:  'no',
  fielder_blocking_path:   'yes',
});
assert(
  'All no-branch questions answered → getNextQuestion returns null (complete)',
  complete_no === null,
  `got: ${complete_no?.id}`,
);

// ── Test 4: buildRulingContext — context assembly ────────────────────────────

section('TEST 4 · buildRulingContext — plain-English context for RAG prompt');

// Scenario: fielder HAD ball, runner DID deviate → clear interference call
const context_interference = buildRulingContext(collisionMatrix, {
  fielder_had_possession: 'yes',
  runner_deviated:        'yes',
});
assert(
  'Interference scenario contains "HAD possession"',
  context_interference.includes('HAD possession'),
  context_interference,
);
assert(
  'Interference scenario contains "deviate" language',
  context_interference.toLowerCase().includes('deliberately deviated') ||
  context_interference.toLowerCase().includes('base path'),
  context_interference,
);
assert(
  'Interference scenario includes ruling_hint',
  context_interference.includes('RULING GUIDANCE'),
  context_interference,
);

console.log('\n  Context string preview:');
console.log(context_interference.split('\n').map(l => `    ${l}`).join('\n'));

// Scenario: fielder had NO ball, WAS blocking → obstruction
const context_obstruction = buildRulingContext(collisionMatrix, {
  fielder_had_possession: 'no',
  fielder_blocking_path:  'yes',
});
assert(
  'Obstruction scenario contains "NOT have possession"',
  context_obstruction.includes('NOT have possession'),
  context_obstruction,
);
assert(
  'Obstruction scenario contains "blocking the base path"',
  context_obstruction.toLowerCase().includes('blocking the base path'),
  context_obstruction,
);

// ── Test 5: Infield fly branching (multi-select depends_on) ──────────────────

section('TEST 5 · infield_fly_rule — multi-step branching');

const ifMatrix = findMatrix('infield_fly_rule');
assert('findMatrix() returns infield_fly matrix', ifMatrix !== null);

const ifQ1 = getNextQuestion(ifMatrix, {});
assert(
  'No answers → first question is "outs_at_time"',
  ifQ1?.id === 'outs_at_time',
  `got: ${ifQ1?.id}`,
);

// With 0 outs → base_occupancy question should appear
const ifQ2_0outs = getNextQuestion(ifMatrix, { outs_at_time: '0 outs' });
assert(
  'outs_at_time=0 outs → next is "base_occupancy" (0-out branch)',
  ifQ2_0outs?.id === 'base_occupancy',
  `got: ${ifQ2_0outs?.id}`,
);

// With 1 out → base_occupancy_1out question should appear
const ifQ2_1out = getNextQuestion(ifMatrix, { outs_at_time: '1 out' });
assert(
  'outs_at_time=1 out → next is "base_occupancy_1out" (1-out branch)',
  ifQ2_1out?.id === 'base_occupancy_1out',
  `got: ${ifQ2_1out?.id}`,
);

// With 2 outs → ball_type (no base occupancy needed — rule can't apply with 2 outs)
const ifQ2_2outs = getNextQuestion(ifMatrix, { outs_at_time: '2 outs' });
assert(
  'outs_at_time=2 outs → next is "ball_type" (base_occupancy branches skipped)',
  ifQ2_2outs?.id === 'ball_type',
  `got: ${ifQ2_2outs?.id}`,
);

// ── Test 6: Matrix coverage — all 7 matrices present ────────────────────────

section('TEST 6 · Matrix registry completeness');

const expectedMatrices = [
  'runner_fielder_collision',
  'infield_fly_rule',
  'dropped_third_strike',
  'check_swing_hbp',
  'fair_foul_ball',
  'appeal_play',
  'force_vs_tag',
];

for (const id of expectedMatrices) {
  const m = findMatrix(id);
  assert(`Matrix "${id}" is registered`, m !== null);
  assert(`Matrix "${id}" has at least one question`, (m?.questions?.length ?? 0) > 0);
  assert(`Matrix "${id}" has trigger keywords`, (m?.triggers?.length ?? 0) > 0);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n  All matrix logic verified. Ready for vercel dev + curl tests.\n');
}
