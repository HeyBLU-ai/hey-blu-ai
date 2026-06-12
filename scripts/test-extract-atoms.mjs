/**
 * scripts/test-extract-atoms.mjs
 *
 * Unit tests for lib/ingest/extract-rule-atoms.mjs.
 *
 * All Anthropic API calls are mocked — no real network traffic.
 * Run with: node scripts/test-extract-atoms.mjs
 */

import { extractRuleAtoms } from '../lib/ingest/extract-rule-atoms.mjs';

// ── Scaffolding ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function expectThrows(label, fn) {
  try {
    await fn();
    console.error(`  ✗ ${label} — expected an error but none was thrown`);
    failed++;
    return null;
  } catch (err) {
    console.log(`  ✓ ${label}`);
    passed++;
    return err;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Two realistic source spans from a baseball rulebook.
const SPAN_A_TEXT =
  'Rule 505. Must Slide Rule. A runner who does not slide and who causes a collision ' +
  'with a fielder holding the ball shall be declared out.';

const SPAN_B_TEXT =
  'Rule 510. Obstruction. When a fielder obstructs a runner who is not in possession ' +
  'of the ball, the umpire shall call obstruction.';

const SPAN_A = { seq: 0, text: SPAN_A_TEXT, page: 15, charStart: 0, charEnd: SPAN_A_TEXT.length };
const SPAN_B = { seq: 1, text: SPAN_B_TEXT, page: 15, charStart: SPAN_A_TEXT.length + 1, charEnd: SPAN_A_TEXT.length + 1 + SPAN_B_TEXT.length };

const ID_A = 'aaaa0000-0000-0000-0000-000000000001';
const ID_B = 'bbbb0000-0000-0000-0000-000000000002';

// A clean verbatim substring from SPAN_A (starts mid-sentence).
const BODY_A_FULL    = SPAN_A_TEXT;
const BODY_A_PARTIAL = 'A runner who does not slide and who causes a collision with a fielder holding the ball shall be declared out.';
const BODY_B_FULL    = SPAN_B_TEXT;

// AI-hallucinated / paraphrased versions — must NOT pass the verbatim guard.
const BODY_A_PARAPHRASE  = 'A runner who fails to slide and collides with a fielder holding the ball is out.';
const BODY_A_EXTRA_WORD  = 'Rule 505. Must Slide Rule. A runner who does not slide and who causes a terrible collision with a fielder holding the ball shall be declared out.';
const BODY_A_CAPITALIZED = SPAN_A_TEXT.replace('runner', 'Runner');

// ── Mock factory ──────────────────────────────────────────────────────────────

/**
 * Build a mock Anthropic client that returns the provided JSON payload.
 *
 * @param {object|string} payload - Object → JSON.stringify'd; string → used as-is.
 * @param {object}        [overrides]
 * @param {boolean}       [overrides.empty]  - Return an empty content string.
 * @param {boolean}       [overrides.throws] - Throw a network-style error.
 */
function makeMockClient(payload, { empty = false, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        if (throws) throw new Error('mock: simulated network failure');
        const text = empty ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload));
        return { content: [{ text }] };
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n━━━  extractRuleAtoms test  ━━━');

// ── Test 1: argument validation — no spans ────────────────────────────────────
console.log('\nTest 1: rejects empty opts.spans');
{
  const err = await expectThrows('1: no spans throws', () =>
    extractRuleAtoms({ spans: [], spanIds: [] }),
  );
  check('1: message mentions "spans"', err?.message?.includes('spans'));
}

// ── Test 2: argument validation — spanIds length mismatch ─────────────────────
console.log('\nTest 2: rejects mismatched spanIds length');
{
  const err = await expectThrows('2: spanIds mismatch throws', () =>
    extractRuleAtoms({
      spans:   [SPAN_A],
      spanIds: [ID_A, ID_B],   // 2 IDs for 1 span
    }),
  );
  check('2: message mentions "parallel array"', err?.message?.includes('parallel array'));
}

// ── Test 3: missing API key (no anthropicClient) ──────────────────────────────
console.log('\nTest 3: throws when no API key and no client override');
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const err = await expectThrows('3: no API key throws', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A] }),
  );
  check('3: message mentions ANTHROPIC_API_KEY', err?.message?.includes('ANTHROPIC_API_KEY'));
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
}

// ── Test 4: happy path — single atom, full span body ─────────────────────────
console.log('\nTest 4: happy path — single atom with full-span body');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_FULL,
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('4a: returns 1 atom',                atoms.length === 1,         `got ${atoms.length}`);
  check('4b: rule_number = "505"',           atoms[0].rule_number === '505');
  check('4c: title correct',                 atoms[0].title === 'Must Slide Rule');
  check('4d: body === BODY_A_FULL',          atoms[0].body === BODY_A_FULL);
  check('4e: sourceSpanId = ID_A',           atoms[0].sourceSpanId === ID_A);
  check('4f: source_ids = [ID_A]',           JSON.stringify(atoms[0].source_ids) === JSON.stringify([ID_A]));
  check('4g: exactly 1 API call made',       client.calls.length === 1, `got ${client.calls.length}`);
}

// ── Test 5: happy path — partial (substring) body ────────────────────────────
console.log('\nTest 5: happy path — atom body is a clean verbatim substring');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule — sub',
      body:        BODY_A_PARTIAL,
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('5a: returns 1 atom',         atoms.length === 1);
  check('5b: body === BODY_A_PARTIAL', atoms[0].body === BODY_A_PARTIAL);
}

// ── Test 6: happy path — two atoms from two spans ─────────────────────────────
console.log('\nTest 6: happy path — two atoms from two different spans');
{
  const payload = {
    atoms: [
      { rule_number: '505', title: 'Must Slide',  body: BODY_A_FULL, source_ids: [ID_A] },
      { rule_number: '510', title: 'Obstruction', body: BODY_B_FULL, source_ids: [ID_B] },
    ],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: client,
  });
  check('6a: returns 2 atoms',               atoms.length === 2);
  check('6b: atoms[0].sourceSpanId = ID_A',  atoms[0].sourceSpanId === ID_A);
  check('6c: atoms[1].sourceSpanId = ID_B',  atoms[1].sourceSpanId === ID_B);
  check('6d: atoms[1].rule_number = "510"',  atoms[1].rule_number === '510');
}

// ── Test 7: empty atoms array → returns [] ────────────────────────────────────
console.log('\nTest 7: empty atoms array → returns []');
{
  const client = makeMockClient({ atoms: [] });
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('7: result is []', Array.isArray(atoms) && atoms.length === 0);
}

// ── Test 8: verbatim guard — paraphrased body ────────────────────────────────
console.log('\nTest 8: verbatim guard — paraphrased body throws');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_PARAPHRASE,   // AI rewrote the sentence
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('8: paraphrase caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('8: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
}

// ── Test 9: verbatim guard — extra inserted word ──────────────────────────────
console.log('\nTest 9: verbatim guard — extra word inserted throws');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_EXTRA_WORD,
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('9: extra word caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('9: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
}

// ── Test 10: verbatim guard — capitalisation change ───────────────────────────
console.log('\nTest 10: verbatim guard — capitalisation change throws');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_CAPITALIZED,   // "Runner" vs "runner"
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('10: capitalisation caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('10: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
}

// ── Test 11: verbatim guard — unknown source_id ───────────────────────────────
console.log('\nTest 11: verbatim guard — unknown source_id throws');
{
  const GHOST_ID = 'ghost000-0000-0000-0000-000000000099';
  const payload  = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_FULL,
      source_ids:  [GHOST_ID],   // not in spanIds
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('11: unknown source_id caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('11: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
  check('11: error mentions unknown span id', err?.message?.includes('unknown span id'));
}

// ── Test 12: verbatim guard — missing source_ids field ───────────────────────
console.log('\nTest 12: verbatim guard — missing source_ids throws');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_FULL,
      // source_ids intentionally omitted
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('12: missing source_ids caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('12: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
  check('12: error mentions source_ids',     err?.message?.includes('source_ids'));
}

// ── Test 13: empty body throws ────────────────────────────────────────────────
console.log('\nTest 13: atom with empty body throws');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        '',
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('13: empty body caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('13: error mentions body', err?.message?.includes('body'));
}

// ── Test 14: invalid JSON response → throws ───────────────────────────────────
console.log('\nTest 14: invalid JSON response throws');
{
  const client = makeMockClient('This is not JSON at all, sorry!');
  const err    = await expectThrows('14: invalid JSON caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('14: error mentions JSON',   err?.message?.toLowerCase().includes('json'));
}

// ── Test 15: missing "atoms" key in JSON ──────────────────────────────────────
console.log('\nTest 15: response with no "atoms" key throws');
{
  const client = makeMockClient({ result: [] });   // wrong key
  const err    = await expectThrows('15: missing atoms key caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('15: error mentions atoms', err?.message?.includes('atoms'));
}

// ── Test 16: empty AI response body → throws ─────────────────────────────────
console.log('\nTest 16: empty AI response throws');
{
  const client = makeMockClient(null, { empty: true });
  const err    = await expectThrows('16: empty response caught', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('16: error mentions empty response', err?.message?.includes('empty'));
}

// ── Test 17: network error from API → propagates ──────────────────────────────
console.log('\nTest 17: network error propagates');
{
  const client = makeMockClient(null, { throws: true });
  const err    = await expectThrows('17: network error propagates', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('17: error message preserved', err?.message?.includes('simulated network failure'));
}

// ── Test 18: batching — 3 spans with batchSize=2 → 2 API calls ───────────────
console.log('\nTest 18: batching — batchSize=2 with 3 spans makes 2 API calls');
{
  const SPAN_C_TEXT = 'Rule 515. Interference. A batter who interferes with the catcher shall be out.';
  const ID_C        = 'cccc0000-0000-0000-0000-000000000003';
  const SPAN_C      = { seq: 2, text: SPAN_C_TEXT, page: 16, charStart: 0, charEnd: SPAN_C_TEXT.length };

  // Build a client that returns the correct atom for whichever spans are in the batch.
  const batchPayloads = [
    // Batch 1: SPAN_A + SPAN_B
    { atoms: [
        { rule_number: '505', title: 'Must Slide',  body: BODY_A_FULL, source_ids: [ID_A] },
        { rule_number: '510', title: 'Obstruction', body: BODY_B_FULL, source_ids: [ID_B] },
    ]},
    // Batch 2: SPAN_C alone
    { atoms: [
        { rule_number: '515', title: 'Interference', body: SPAN_C_TEXT, source_ids: [ID_C] },
    ]},
  ];

  let callIdx = 0;
  const client = {
    calls: [],
    messages: {
      async create(req) {
        client.calls.push(req);
        const payload = batchPayloads[callIdx++];
        return { content: [{ text: JSON.stringify(payload) }] };
      },
    },
  };

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B, SPAN_C],
    spanIds:         [ID_A, ID_B, ID_C],
    anthropicClient: client,
    batchSize:       2,
  });

  check('18a: 2 API calls made',     client.calls.length === 2, `got ${client.calls.length}`);
  check('18b: 3 atoms returned',     atoms.length === 3,        `got ${atoms.length}`);
  check('18c: atoms[0] = SPAN_A',    atoms[0].sourceSpanId === ID_A);
  check('18d: atoms[2] = SPAN_C',    atoms[2].sourceSpanId === ID_C);
  check('18e: atoms[2].rule = "515"', atoms[2].rule_number === '515');
}

// ── Test 19: rule_number coerced to string ────────────────────────────────────
console.log('\nTest 19: rule_number coerced to string even when AI returns a number');
{
  const payload = {
    atoms: [{
      rule_number: 505,      // integer from AI
      title:       'Must Slide Rule',
      body:        BODY_A_FULL,
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('19: rule_number is string "505"', atoms[0].rule_number === '505', `got ${typeof atoms[0].rule_number}`);
}

// ── Test 20: atom with no rule_number → empty string ─────────────────────────
console.log('\nTest 20: missing rule_number → empty string ""');
{
  const payload = {
    atoms: [{
      title:      'Unnamed Rule',
      body:       BODY_A_FULL,
      source_ids: [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('20: rule_number === ""', atoms[0].rule_number === '', `got "${atoms[0].rule_number}"`);
}

// ── Test 21: atom body is found in second source_id (multi-span atom) ─────────
console.log('\nTest 21: atom body valid when found in second source_id');
{
  // AI cites both spans but body lives only in SPAN_B.
  const payload = {
    atoms: [{
      rule_number: '510',
      title:       'Obstruction',
      body:        BODY_B_FULL,
      source_ids:  [ID_A, ID_B],   // ID_A first, body is not in SPAN_A
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: client,
  });
  check('21a: returns 1 atom',             atoms.length === 1);
  check('21b: sourceSpanId = ID_A (first)', atoms[0].sourceSpanId === ID_A);
  check('21c: source_ids has both',        atoms[0].source_ids.length === 2);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
