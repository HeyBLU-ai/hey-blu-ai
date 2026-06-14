/**
 * scripts/test-verifier-gate.mjs
 *
 * Unit tests for the blocking verifier gate in api/verifier.js.
 *
 * All tests use mocked Anthropic clients — no real API calls are made.
 * Tests cover every code path: approved pass-through, unsupported block,
 * no_rule_found pass-through, malformed JSON fail-closed, and API error fail-closed.
 *
 * Usage:
 *   node scripts/test-verifier-gate.mjs
 */

import { runVerifier, isVerifierBlocked, buildVerifierPrompt } from '../api/verifier.js';

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

/** Build a mock Anthropic client that returns the given text as the verifier response. */
function mockClient(responseText) {
  return {
    messages: {
      create: async () => ({
        content: [{ text: responseText }],
      }),
    },
  };
}

/** Build a mock client that throws on create. */
function mockFailingClient(errorMessage) {
  return {
    messages: {
      create: async () => { throw new Error(errorMessage); },
    },
  };
}

// Sample evidence bundles (used in multiple tests)
const SAMPLE_BUNDLES = [
  {
    bundle_id:      'aaaa-1111',
    rule_number:    '505',
    canonical_text: 'Runners never have to slide but, if a runner chooses to do so, the slide must be legal.',
    page_start:     12,
  },
  {
    bundle_id:      'bbbb-2222',
    rule_number:    '505',
    canonical_text: 'If a runner slides, the runner must slide within reach of the base with either a hand or a foot.',
    page_start:     12,
  },
];

const APPROVED_DRAFT = 'According to Rule 505, runners do not have to slide, but any slide must be legal and the runner must remain within reach of the base.';

const HALLUCINATED_DRAFT = 'According to Rule 505, runners must always slide headfirst into second base and must wear batting gloves while doing so.';

const NO_RULE_DRAFT = 'I could not find a specific rule about this in the loaded rulebook.';

// ── Test 1: Approved answer passes the gate ───────────────────────────────────

console.log('\nTest 1: approved verifier response → gate passes');
{
  const approvedJson = JSON.stringify({
    status:              'approved',
    claims:              [
      { claim: 'Runners do not have to slide', supported: true, source_ids: ['aaaa-1111'] },
      { claim: 'Any slide must be legal',      supported: true, source_ids: ['aaaa-1111'] },
      { claim: 'Runner must stay within reach of base', supported: true, source_ids: ['bbbb-2222'] },
    ],
    unsupported_claims:  [],
    confidence:          'high',
  });

  const audit = await runVerifier({
    anthropicClient: mockClient(approvedJson),
    draftAnswer:     APPROVED_DRAFT,
    bundles:         SAMPLE_BUNDLES,
  });

  check('status = approved',              audit.status === 'approved',       `got "${audit.status}"`);
  check('unsupported_claims is empty',    audit.unsupported_claims.length === 0);
  check('confidence = high',             audit.confidence === 'high',       `got "${audit.confidence}"`);
  check('claims array has 3 items',       audit.claims.length === 3,         `got ${audit.claims.length}`);
  check('gate does NOT block',            !isVerifierBlocked(audit),          'gate returned true (blocked) unexpectedly');
}

// ── Test 2: Hallucinated answer is blocked ────────────────────────────────────

console.log('\nTest 2: unsupported verifier response → gate blocks (hallucination caught)');
{
  const blockedJson = JSON.stringify({
    status:             'unsupported',
    claims:             [
      { claim: 'Runners must always slide headfirst into second base', supported: false, source_ids: [] },
      { claim: 'Runners must wear batting gloves while sliding',        supported: false, source_ids: [] },
    ],
    unsupported_claims: [
      'Runners must always slide headfirst into second base',
      'Runners must wear batting gloves while sliding',
    ],
    confidence:         'high',
  });

  const audit = await runVerifier({
    anthropicClient: mockClient(blockedJson),
    draftAnswer:     HALLUCINATED_DRAFT,
    bundles:         SAMPLE_BUNDLES,
  });

  check('status = unsupported',            audit.status === 'unsupported',   `got "${audit.status}"`);
  check('unsupported_claims has 2 items',  audit.unsupported_claims.length === 2, `got ${audit.unsupported_claims.length}`);
  check('gate BLOCKS the response',        isVerifierBlocked(audit),          'gate returned false (passed) — hallucination not caught');
  check('first unsupported claim correct', audit.unsupported_claims[0].includes('headfirst'));
}

// ── Test 3: no_rule_found passes the gate ─────────────────────────────────────

console.log('\nTest 3: no_rule_found verifier response → gate passes (correct abstention)');
{
  const noRuleJson = JSON.stringify({
    status:             'no_rule_found',
    claims:             [
      { claim: 'No specific rule was found', supported: true, source_ids: [] },
    ],
    unsupported_claims: [],
    confidence:         'high',
  });

  const audit = await runVerifier({
    anthropicClient: mockClient(noRuleJson),
    draftAnswer:     NO_RULE_DRAFT,
    bundles:         [],
  });

  check('status = no_rule_found',   audit.status === 'no_rule_found',  `got "${audit.status}"`);
  check('unsupported_claims empty', audit.unsupported_claims.length === 0);
  check('gate does NOT block',      !isVerifierBlocked(audit),          'gate blocked a correct abstention');
}

// ── Test 4: Malformed JSON → fail-closed block ────────────────────────────────

console.log('\nTest 4: malformed verifier JSON → fail-closed (gate blocks)');
{
  const malformedResponse = 'Sorry, I cannot process this request right now. The answer looks fine though!';

  const audit = await runVerifier({
    anthropicClient: mockClient(malformedResponse),
    draftAnswer:     APPROVED_DRAFT,
    bundles:         SAMPLE_BUNDLES,
  });

  check('status = unsupported (sentinel)', audit.status === 'unsupported',     `got "${audit.status}"`);
  check('_error = parse_error',            audit._error === 'parse_error',      `got "${audit._error}"`);
  check('gate BLOCKS (fail-closed)',        isVerifierBlocked(audit),            'gate did not block on parse failure');
  check('unsupported_claims contains hint', audit.unsupported_claims.some(c => c.includes('parse_error')));
}

// ── Test 5: Verifier API error → fail-closed block ────────────────────────────

console.log('\nTest 5: verifier API throws → fail-closed (gate blocks)');
{
  const audit = await runVerifier({
    anthropicClient: mockFailingClient('overloaded_error: service unavailable'),
    draftAnswer:     APPROVED_DRAFT,
    bundles:         SAMPLE_BUNDLES,
  });

  check('status = unsupported (sentinel)', audit.status === 'unsupported',     `got "${audit.status}"`);
  check('_error = api_error',              audit._error === 'api_error',        `got "${audit._error}"`);
  check('gate BLOCKS (fail-closed)',        isVerifierBlocked(audit),            'gate did not block on API error');
  check('error message preserved',         audit.unsupported_claims.some(c => c.includes('overloaded_error')));
}

// ── Test 6: Mixed claims — some supported, some not → gate blocks ─────────────

console.log('\nTest 6: mixed claims (one unsupported) → gate blocks even if status = "approved"');
{
  // Simulate a verifier that says "approved" but still lists unsupported claims
  // (defensive: the gate checks unsupported_claims length independently of status)
  const mixedJson = JSON.stringify({
    status:             'approved',
    claims:             [
      { claim: 'Runners do not have to slide', supported: true,  source_ids: ['aaaa-1111'] },
      { claim: 'Runners must tag up after every fly ball', supported: false, source_ids: [] },
    ],
    unsupported_claims: ['Runners must tag up after every fly ball'],
    confidence:         'medium',
  });

  const audit = await runVerifier({
    anthropicClient: mockClient(mixedJson),
    draftAnswer:     'Runners do not have to slide. Runners must also tag up after every fly ball.',
    bundles:         SAMPLE_BUNDLES,
  });

  check('status = approved (as returned by verifier)', audit.status === 'approved');
  check('unsupported_claims has 1 item',               audit.unsupported_claims.length === 1);
  check('gate BLOCKS despite approved status',          isVerifierBlocked(audit),
        'gate did not catch unsupported_claims when status was erroneously "approved"');
}

// ── Test 7: buildVerifierPrompt includes source IDs ───────────────────────────

console.log('\nTest 7: buildVerifierPrompt correctly formats bundle IDs and rule numbers');
{
  const prompt = buildVerifierPrompt(APPROVED_DRAFT, SAMPLE_BUNDLES);

  check('prompt contains source_id aaaa-1111', prompt.includes('aaaa-1111'));
  check('prompt contains source_id bbbb-2222', prompt.includes('bbbb-2222'));
  check('prompt contains rule number 505',      prompt.includes('505'));
  check('prompt contains draft answer text',    prompt.includes('Runners never have to slide') || prompt.includes('According to Rule 505'));
  check('prompt contains exact_text of span 1', prompt.includes('Runners never have to slide'));
  check('prompt contains exact_text of span 2', prompt.includes('runner must slide within reach'));
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(56));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(56) + '\n');

if (failed > 0) process.exit(1);
