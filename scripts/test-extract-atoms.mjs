/**
 * scripts/test-extract-atoms.mjs
 *
 * Unit tests for lib/ingest/extract-rule-atoms.mjs.
 *
 * All Anthropic API calls are mocked — no real network traffic.
 * Run with: node scripts/test-extract-atoms.mjs
 */

import { extractRuleAtoms, deriveAtomKey } from '../lib/ingest/extract-rule-atoms.mjs';
import { canonicalizeBody }                from '../lib/ingest/utils.mjs';

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

// ── Test 10: normalization — capitalisation-only change → guard passes ────────
// findNormalizedSubstring normalises both sides to lowercase, so a capitalisation-
// only difference is excused.  The stored body is sliced from the ORIGINAL source
// (lowercase "runner"), not from the AI's response ("Runner").
console.log('\nTest 10: normalization — capitalisation-only change passes verbatim guard');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_CAPITALIZED,   // "Runner" vs "runner" — only casing differs
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: client,
  });
  check('10a: capitalisation variant accepted — returns 1 atom', atoms.length === 1,
        `got ${atoms.length}`);
  // Body must be sliced from ORIGINAL source (lowercase "runner"), not from AI
  check('10b: body sliced from original source, not AI response',
        atoms[0].body === SPAN_A_TEXT,
        `got: "${atoms[0].body.slice(0, 60)}…"`);
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

// ─────────────────────────────────────────────────────────────────────────────
// DB insertion tests (Tests 22–27)
// Uses an injected mock dbClient — no real Postgres connection needed.
// ─────────────────────────────────────────────────────────────────────────────

const LEAGUE_ID   = 'league00-0000-0000-0000-000000000001';
const VERSION_ID  = 'version0-0000-0000-0000-000000000001';

/**
 * Build a mock pg-compatible client that records all query calls and returns
 * synthetic UUIDs for rules INSERTs.
 */
function makeMockDb() {
  const calls = [];
  let ruleCounter = 0;
  return {
    calls,
    async query(text, values) {
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      // rules UPSERT → return a synthetic UUID
      if (norm.includes('INSERT INTO rules')) {
        ruleCounter++;
        return { rows: [{ id: `rule-uuid-${ruleCounter}` }] };
      }
      // rule_source_links INSERT → ON CONFLICT DO NOTHING, no rows returned
      return { rows: [] };
    },
  };
}

// Reusable AI payload for two atoms (SPAN_A and SPAN_B)
const TWO_ATOM_AI_PAYLOAD = {
  atoms: [
    { rule_number: '505', title: 'Must Slide',  body: BODY_A_FULL, source_ids: [ID_A] },
    { rule_number: '510', title: 'Obstruction', body: BODY_B_FULL, source_ids: [ID_B] },
  ],
};

// ── Test 22: single atom — correct rules UPSERT SQL and parameters ────────────
console.log('\nTest 22: DB path — rules UPSERT SQL and parameters');
{
  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '505', title: 'Must Slide Rule', body: BODY_A_FULL, source_ids: [ID_A] },
  ]});

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCall = db.calls.find(c => c.text.includes('INSERT INTO rules'));
  check('22a: rules UPSERT was called',               ruleCall != null);
  check('22b: SQL contains ON CONFLICT … DO UPDATE',  ruleCall?.text.includes('ON CONFLICT'));
  check('22c: SQL RETURNING id',                      ruleCall?.text.includes('RETURNING id'));
  check('22d: $1 = leagueId',                         ruleCall?.values[0] === LEAGUE_ID);
  check('22e: $2 = versionId',                        ruleCall?.values[1] === VERSION_ID);
  check('22f: $3 = atom_key starts with "505#"',       ruleCall?.values[2]?.startsWith('505#'),
        `got "${ruleCall?.values[2]}"`);
  check('22f2: $3 = atom_key has 12-char hash suffix', ruleCall?.values[2]?.split('#')[1]?.length === 12,
        `got "${ruleCall?.values[2]}"`);
  check('22f3: $4 = rule_number display "505"',        ruleCall?.values[3] === '505');
  check('22g: $5 = title "Must Slide Rule"',          ruleCall?.values[4] === 'Must Slide Rule');
  check('22h: $6 = body is verbatim BODY_A_FULL',     ruleCall?.values[5] === BODY_A_FULL);
  check('22i: $7 = "baseball" (default sport)',       ruleCall?.values[6] === 'baseball');
  check('22j: returned atom has ruleId',              atoms[0]?.ruleId === 'rule-uuid-1',
        `got "${atoms[0]?.ruleId}"`);
}

// ── Test 23: single atom — rule_source_links INSERT SQL and parameters ────────
console.log('\nTest 23: DB path — rule_source_links INSERT SQL and parameters');
{
  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '505', title: 'Must Slide Rule', body: BODY_A_FULL, source_ids: [ID_A] },
  ]});

  await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const linkCall = db.calls.find(c => c.text.includes('INSERT INTO rule_source_links'));
  check('23a: rule_source_links INSERT was called',        linkCall != null);
  check('23b: SQL contains ON CONFLICT … DO NOTHING',      linkCall?.text.includes('DO NOTHING'));
  check('23c: $1 = rule UUID from rules UPSERT',           linkCall?.values[0] === 'rule-uuid-1',
        `got "${linkCall?.values[0]}"`);
  check('23d: $2 = source span ID',                        linkCall?.values[1] === ID_A);
  check('23e: $3 = "supports" (link_type)',                 linkCall?.values[2] === 'supports');
}

// ── Test 24: atom with two source_ids → two rule_source_links rows ────────────
console.log('\nTest 24: atom with two source_ids → two rule_source_links INSERTs');
{
  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '505', title: 'Must Slide', body: BODY_A_FULL, source_ids: [ID_A, ID_B] },
  ]});

  await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const linkCalls = db.calls.filter(c => c.text.includes('INSERT INTO rule_source_links'));
  check('24a: 2 rule_source_links INSERTs',         linkCalls.length === 2, `got ${linkCalls.length}`);
  check('24b: first link → ID_A',                   linkCalls[0]?.values[1] === ID_A);
  check('24c: second link → ID_B',                  linkCalls[1]?.values[1] === ID_B);
  check('24d: both share same rule_id',             linkCalls[0]?.values[0] === linkCalls[1]?.values[0]);
}

// ── Test 25: two atoms → two rules UPSERTs + two link INSERTs ─────────────────
console.log('\nTest 25: two atoms → 2 rules UPSERTs + 2 link INSERTs (4 total calls)');
{
  const db = makeMockDb();
  const aiClient = makeMockClient(TWO_ATOM_AI_PAYLOAD);

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCalls = db.calls.filter(c => c.text.includes('INSERT INTO rules'));
  const linkCalls = db.calls.filter(c => c.text.includes('INSERT INTO rule_source_links'));
  check('25a: 2 rules UPSERTs',                      ruleCalls.length === 2, `got ${ruleCalls.length}`);
  check('25b: 2 rule_source_links INSERTs',          linkCalls.length === 2, `got ${linkCalls.length}`);
  check('25c: atoms[0].ruleId = "rule-uuid-1"',      atoms[0].ruleId === 'rule-uuid-1');
  check('25d: atoms[1].ruleId = "rule-uuid-2"',      atoms[1].ruleId === 'rule-uuid-2');
  check('25e: link[0].rule_id = atoms[0].ruleId',    linkCalls[0].values[0] === atoms[0].ruleId);
  check('25f: link[1].rule_id = atoms[1].ruleId',    linkCalls[1].values[0] === atoms[1].ruleId);
}

// ── Test 26: no dbClient → DB calls skipped, atoms returned without ruleId ────
console.log('\nTest 26: no dbClient → DB skipped, atoms returned without ruleId');
{
  const aiClient = makeMockClient(TWO_ATOM_AI_PAYLOAD);

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    // dbClient intentionally omitted
    leagueId:        LEAGUE_ID,
  });

  check('26a: returns 2 atoms',          atoms.length === 2);
  check('26b: atoms[0] has no ruleId',   atoms[0].ruleId === undefined,
        `got "${atoms[0].ruleId}"`);
}

// ── Test 27: dbClient present but no leagueId → DB skipped ───────────────────
console.log('\nTest 27: dbClient present but no leagueId → DB skipped');
{
  const db = makeMockDb();
  const aiClient = makeMockClient(TWO_ATOM_AI_PAYLOAD);

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    versionId:       VERSION_ID,
    // leagueId intentionally omitted → DB must be skipped
  });

  check('27a: returns 2 atoms',         atoms.length === 2);
  check('27b: no DB calls made',        db.calls.length === 0, `got ${db.calls.length}`);
  check('27c: atoms[0] has no ruleId',  atoms[0].ruleId === undefined);
}

// ── Test 27b: dbClient + leagueId present but no versionId → DB skipped ──────
console.log('\nTest 27b: dbClient present but no versionId → DB skipped');
{
  const db = makeMockDb();
  const aiClient = makeMockClient(TWO_ATOM_AI_PAYLOAD);

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    // versionId intentionally omitted → DB must be skipped
  });

  check('27b-a: returns 2 atoms',         atoms.length === 2);
  check('27b-b: no DB calls made',        db.calls.length === 0, `got ${db.calls.length}`);
  check('27b-c: atoms[0] has no ruleId',  atoms[0].ruleId === undefined);
}

// ── Test 27c: unnumbered atoms get [Unnumbered-N] placeholder in DB ───────────
console.log('\nTest 27c: unnumbered atoms — [Unnumbered-N] placeholder prevents squashing');
{
  const db = makeMockDb();
  // Two atoms with empty rule_number — must NOT overwrite each other
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '', title: 'First unnumbered',  body: BODY_A_FULL, source_ids: [ID_A] },
    { rule_number: '', title: 'Second unnumbered', body: BODY_B_FULL, source_ids: [ID_B] },
  ]});

  await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCalls = db.calls.filter(c => c.text.includes('INSERT INTO rules'));
  check('27c-a: 2 separate rules UPSERTs (not 1)',   ruleCalls.length === 2, `got ${ruleCalls.length}`);
  // $3 = atom_key (content hash), $4 = rule_number display (empty for unnumbered)
  check('27c-b: first  atom_key starts with "unnumbered#"',
        ruleCalls[0]?.values[2]?.startsWith('unnumbered#'), `got "${ruleCalls[0]?.values[2]}"`);
  check('27c-c: second atom_key starts with "unnumbered#"',
        ruleCalls[1]?.values[2]?.startsWith('unnumbered#'), `got "${ruleCalls[1]?.values[2]}"`);
  check('27c-d: two different unnumbered atoms have different atom_keys',
        ruleCalls[0]?.values[2] !== ruleCalls[1]?.values[2],
        `both: "${ruleCalls[0]?.values[2]}"`);
  check('27c-e: first  rule_number display = "" (empty)',  ruleCalls[0]?.values[3] === '');
  check('27c-f: second rule_number display = "" (empty)',  ruleCalls[1]?.values[3] === '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation tests (Tests 28–30)
// Verify findNormalizedSubstring in verifyAtomVerbatim excuses formatting
// artefacts while still catching semantic changes.
// ─────────────────────────────────────────────────────────────────────────────

// ── Test 28: Whitespace variant in atom body → body sliced from original ──────
// Source text has double spaces; AI normalises to single space.
// Guard passes (normalisation excuses whitespace), but stored body is sliced
// from the ORIGINAL source — preserving the original double-space formatting.
console.log('\nTest 28: normalization — whitespace variant → body sliced from original source');
{
  const SRC_TEXT_WS  = 'Rule 505.  Must Slide Rule.  A runner who does not slide is out.';
  const SPAN_WS      = { seq: 0, text: SRC_TEXT_WS, page: 1, charStart: 0, charEnd: SRC_TEXT_WS.length };
  const ID_WS        = 'ws000000-0000-0000-0000-000000000001';
  const AI_BODY_WS   = 'Rule 505. Must Slide Rule. A runner who does not slide is out.';  // single spaces

  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        AI_BODY_WS,
      source_ids:  [ID_WS],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_WS],
    spanIds:         [ID_WS],
    anthropicClient: client,
  });
  check('28a: whitespace variant accepted', atoms.length === 1, `got ${atoms.length}`);
  // Body must be sliced from ORIGINAL (double spaces), not from AI (single spaces)
  check('28b: body sliced from original source (double-space preserved)',
        atoms[0].body === SRC_TEXT_WS,
        `got: "${atoms[0].body}"`);
  check('28c: body does NOT match single-space AI version',
        atoms[0].body !== AI_BODY_WS);
}

// ── Test 29: Smart quotes in atom body → body sliced from original ────────────
// Source uses straight apostrophes; AI returns typographic RIGHT SINGLE QUOTATION
// MARKs (\u2019).  Guard passes, but stored body is from the ORIGINAL source
// (straight apostrophes), not the AI's typographic version.
console.log('\nTest 29: normalization — smart quotes → body sliced from original source');
{
  const SRC_TEXT_Q = "The catcher's interference rule applies when the batter's swing is impeded.";
  const SPAN_Q     = { seq: 0, text: SRC_TEXT_Q, page: 1, charStart: 0, charEnd: SRC_TEXT_Q.length };
  const ID_Q       = 'qq000000-0000-0000-0000-000000000002';
  const AI_BODY_Q  = 'The catcher\u2019s interference rule applies when the batter\u2019s swing is impeded.';

  const payload = {
    atoms: [{
      rule_number: '',
      title:       "Catcher's Interference",
      body:        AI_BODY_Q,
      source_ids:  [ID_Q],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [SPAN_Q],
    spanIds:         [ID_Q],
    anthropicClient: client,
  });
  check('29a: smart-quote variant accepted', atoms.length === 1, `got ${atoms.length}`);
  // Body must be sliced from ORIGINAL (straight apostrophes), not AI (smart quotes)
  check('29b: body sliced from original source (straight apostrophes)',
        atoms[0].body === SRC_TEXT_Q,
        `got: "${atoms[0].body}"`);
  check('29c: body does NOT contain smart quotes',
        !atoms[0].body.includes('\u2019'));
}

// ── Test 30: Hallucinated word still rejected after normalization ──────────────
// Normalisation must not excuse words that were added or changed.
console.log('\nTest 30: normalization — hallucinated word still rejected');
{
  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        BODY_A_PARAPHRASE,   // AI rewrote the sentence with different words
      source_ids:  [ID_A],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows('30: hallucination still caught after normalization', () =>
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: client }),
  );
  check('30: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-span verbatim guard tests (Tests 31–32)
// Verify that verifyAtomVerbatim handles atoms whose bodies straddle the
// boundary between two consecutive source spans (e.g. a page break in a PDF).
// ─────────────────────────────────────────────────────────────────────────────

// ── Test 31: Body spans two adjacent source spans → guard passes ───────────────
// The atom body is the verbatim concatenation of the end of SPAN_A and the
// start of SPAN_B, joined by a newline.  Neither span alone contains the full
// body, so the guard must fall back to the cross-span concatenation check.
console.log('\nTest 31: cross-span — body stitched across two spans → guard passes');
{
  // Build two spans that together form one complete rule sentence.
  const PART_1 = 'Rule 505. Must Slide Rule. A runner approaching home plate';
  const PART_2 = 'must slide or divert course when the catcher has the ball.';
  const CROSS_SPAN_A = { seq: 0, text: PART_1, page: 14, charStart: 0, charEnd: PART_1.length };
  const CROSS_SPAN_B = { seq: 1, text: PART_2, page: 15, charStart: PART_1.length + 1, charEnd: PART_1.length + 1 + PART_2.length };
  const ID_CROSS_A   = 'cross-a00-0000-0000-0000-000000000001';
  const ID_CROSS_B   = 'cross-b00-0000-0000-0000-000000000002';

  // The atom body is the exact join across the page break.
  const CROSS_BODY = `${PART_1}\n${PART_2}`;

  const payload = {
    atoms: [{
      rule_number: '505',
      title:       'Must Slide Rule',
      body:        CROSS_BODY,
      source_ids:  [ID_CROSS_A, ID_CROSS_B],
    }],
  };
  const client = makeMockClient(payload);
  const atoms  = await extractRuleAtoms({
    spans:           [CROSS_SPAN_A, CROSS_SPAN_B],
    spanIds:         [ID_CROSS_A, ID_CROSS_B],
    anthropicClient: client,
  });
  check('31a: cross-span body accepted — returns 1 atom', atoms.length === 1,
        `got ${atoms.length}`);
  check('31b: body preserved as stitched text',           atoms[0].body === CROSS_BODY);
  check('31c: both span ids in source_ids',               atoms[0].source_ids.length === 2);
  check('31d: sourceSpanId is first span id',             atoms[0].sourceSpanId === ID_CROSS_A);
}

// ── Test 32: Hallucinated word in cross-span body → guard still rejects ────────
// Even with two source spans, an atom whose body contains a word not present in
// either span or their concatenation must be rejected.
console.log('\nTest 32: cross-span — hallucinated word in stitched body → guard rejects');
{
  const PART_1 = 'Rule 506. Obstruction. A fielder without possession';
  const PART_2 = 'who impedes a runner shall be called for obstruction.';
  const CROSS_SPAN_A = { seq: 0, text: PART_1, page: 15, charStart: 0, charEnd: PART_1.length };
  const CROSS_SPAN_B = { seq: 1, text: PART_2, page: 16, charStart: PART_1.length + 1, charEnd: PART_1.length + 1 + PART_2.length };
  const ID_CROSS_A   = 'cross-c00-0000-0000-0000-000000000003';
  const ID_CROSS_B   = 'cross-d00-0000-0000-0000-000000000004';

  // AI stitches correctly but inserts "deliberately" — a hallucinated word.
  const HALLUCINATED_BODY = `${PART_1}\nwho deliberately impedes a runner shall be called for obstruction.`;

  const payload = {
    atoms: [{
      rule_number: '506',
      title:       'Obstruction',
      body:        HALLUCINATED_BODY,
      source_ids:  [ID_CROSS_A, ID_CROSS_B],
    }],
  };
  const client = makeMockClient(payload);
  const err    = await expectThrows(
    '32: hallucinated word in cross-span body still caught',
    () => extractRuleAtoms({
      spans:           [CROSS_SPAN_A, CROSS_SPAN_B],
      spanIds:         [ID_CROSS_A, ID_CROSS_B],
      anthropicClient: client,
    }),
  );
  check('32: error mentions VERBATIM GUARD', err?.message?.includes('VERBATIM GUARD'));
}

// ─────────────────────────────────────────────────────────────────────────────
// New correctness tests (Tests 33–36) — added per advisor accuracy audit
// ─────────────────────────────────────────────────────────────────────────────

// ── Test 33: duplicate rule_number → two atoms with distinct atom_keys ─────
// Two atoms both have rule_number "505".  The DB UPSERT must produce two
// separate rows: atom_key "505" for the first and "505-2" for the second.
// Without atom_key support, the second UPSERT would overwrite the first.
console.log('\nTest 33: duplicate rule_number → distinct atom_keys in DB ("505" and "505-2")');
{
  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '505', title: 'Must Slide (Part 1)', body: BODY_A_FULL,    source_ids: [ID_A] },
    { rule_number: '505', title: 'Must Slide (Part 2)', body: BODY_B_FULL,    source_ids: [ID_B] },
  ]});

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B],
    spanIds:         [ID_A, ID_B],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCalls = db.calls.filter(c => c.text.includes('INSERT INTO rules'));
  check('33a: 2 rules UPSERTs (one per atom)',         ruleCalls.length === 2, `got ${ruleCalls.length}`);
  // $3 = atom_key, $4 = rule_number display
  check('33b: first  atom_key starts with "505#"',     ruleCalls[0]?.values[2]?.startsWith('505#'),
        `got "${ruleCalls[0]?.values[2]}"`);
  check('33c: second atom_key starts with "505#"',     ruleCalls[1]?.values[2]?.startsWith('505#'),
        `got "${ruleCalls[1]?.values[2]}"`);
  check('33d: two "505" atoms have DIFFERENT atom_keys (different bodies)',
        ruleCalls[0]?.values[2] !== ruleCalls[1]?.values[2],
        `both: "${ruleCalls[0]?.values[2]}"`);
  check('33e: both rule_number display = "505"',       ruleCalls[0]?.values[3] === '505' &&
                                                       ruleCalls[1]?.values[3] === '505');
  check('33f: returned atoms carry distinct atomKey fields',
        atoms[0]?.atomKey?.startsWith('505#') &&
        atoms[1]?.atomKey?.startsWith('505#') &&
        atoms[0]?.atomKey !== atoms[1]?.atomKey);
}

// ── Test 34: AI whitespace/casing differences are NOT stored ────────────────
// Comprehensive test: the DB receives the ORIGINAL source text for body,
// regardless of what whitespace or casing the AI returned.  Verifies that
// all three body parameters passed to the UPSERT ($6) equal the source.
console.log('\nTest 34: AI whitespace/casing variants are NOT stored — original source is');
{
  const ORIGINAL_BODY = 'Rule 505.  Must Slide.  A runner who does not slide is out.';
  const SPAN_ORIG = { seq: 0, text: ORIGINAL_BODY, page: 1, charStart: 0, charEnd: ORIGINAL_BODY.length };
  const ID_ORIG   = 'orig0000-0000-0000-0000-000000000001';

  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    {
      rule_number: '505',
      title:       'Must Slide',
      // AI collapses whitespace AND capitalises "Runner" — two differences
      body:        'Rule 505. Must Slide. a Runner who does not slide is out.',
      source_ids:  [ID_ORIG],
    },
  ]});

  const atoms = await extractRuleAtoms({
    spans:           [SPAN_ORIG],
    spanIds:         [ID_ORIG],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCall = db.calls.find(c => c.text.includes('INSERT INTO rules'));
  // $6 = body param in the new 7-param UPSERT
  const storedBody = ruleCall?.values[5];
  check('34a: guard passes (whitespace + casing excused)', atoms.length === 1,
        `got ${atoms.length}`);
  check('34b: stored body = ORIGINAL source (double-space, lowercase)',
        storedBody === ORIGINAL_BODY, `got: "${storedBody}"`);
  check('34c: stored body does NOT match AI version (single-space)',
        storedBody !== 'Rule 505. Must Slide. a Runner who does not slide is out.');
}

// ── Test 35: atom_key is exposed on returned atoms (no DB) ─────────────────
// When the DB path is not invoked (no dbClient), the in-memory atoms do not
// have an atomKey.  When DB is invoked, atomKey IS present.
// This confirms the atomKey field is threaded through correctly.
console.log('\nTest 35: atomKey is always computed (memory-only and DB paths)');
{
  const payload = { atoms: [
    { rule_number: '505', title: 'Must Slide', body: BODY_A_FULL, source_ids: [ID_A] },
  ]};

  // Memory-only path: atomKey must be present even without a DB client
  const memAtoms = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: makeMockClient(payload),
  });
  check('35a: memory-only atom has atomKey starting with "505#"',
        memAtoms[0]?.atomKey?.startsWith('505#'), `got "${memAtoms[0]?.atomKey}"`);

  // DB path: atomKey must be identical to what the memory path computed
  const db = makeMockDb();
  const dbAtoms = await extractRuleAtoms({
    spans:           [SPAN_A],
    spanIds:         [ID_A],
    anthropicClient: makeMockClient(payload),
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });
  check('35b: DB-written atom has same atomKey as memory-only atom',
        dbAtoms[0]?.atomKey === memAtoms[0]?.atomKey,
        `mem="${memAtoms[0]?.atomKey}" db="${dbAtoms[0]?.atomKey}"`);
  check('35c: DB UPSERT $3 = atom.atomKey',
        db.calls.find(c => c.text.includes('INSERT INTO rules'))?.values[2] === dbAtoms[0]?.atomKey);
}

// ── Test 36: third duplicate rule_number → atom_key "505-3" ────────────────
// Extends test 33 to verify the sequence continues correctly for three atoms
// with the same rule_number.
console.log('\nTest 36: three atoms with same rule_number → atom_keys "505", "505-2", "505-3"');
{
  const SPAN_C_TEXT2 = 'Rule 505. Exception: no slide required on a pop-up fly ball.';
  const ID_C2        = 'c2c20000-0000-0000-0000-000000000003';
  const SPAN_C2      = { seq: 2, text: SPAN_C_TEXT2, page: 16, charStart: 0, charEnd: SPAN_C_TEXT2.length };

  const db = makeMockDb();
  const aiClient = makeMockClient({ atoms: [
    { rule_number: '505', title: 'Part 1', body: BODY_A_FULL,    source_ids: [ID_A] },
    { rule_number: '505', title: 'Part 2', body: BODY_B_FULL,    source_ids: [ID_B] },
    { rule_number: '505', title: 'Part 3', body: SPAN_C_TEXT2,   source_ids: [ID_C2] },
  ]});

  await extractRuleAtoms({
    spans:           [SPAN_A, SPAN_B, SPAN_C2],
    spanIds:         [ID_A, ID_B, ID_C2],
    anthropicClient: aiClient,
    dbClient:        db,
    leagueId:        LEAGUE_ID,
    versionId:       VERSION_ID,
  });

  const ruleCalls = db.calls.filter(c => c.text.includes('INSERT INTO rules'));
  check('36a: 3 rules UPSERTs',                    ruleCalls.length === 3, `got ${ruleCalls.length}`);
  check('36b: atom_key[0] starts with "505#"',     ruleCalls[0]?.values[2]?.startsWith('505#'));
  check('36c: atom_key[1] starts with "505#"',     ruleCalls[1]?.values[2]?.startsWith('505#'));
  check('36d: atom_key[2] starts with "505#"',     ruleCalls[2]?.values[2]?.startsWith('505#'));
  check('36e: all three atom_keys are distinct',
        new Set([ruleCalls[0]?.values[2], ruleCalls[1]?.values[2], ruleCalls[2]?.values[2]]).size === 3);
  check('36f: rule_number display always "505"',   ruleCalls.every(c => c.values[3] === '505'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stability tests (Tests 37–40) — atom_key is content-derived, not positional
// ─────────────────────────────────────────────────────────────────────────────

// ── Test 37: Same atom → identical atom_key on two separate ingest calls ──────
// Re-ingesting the same rulebook must produce exactly the same atom_key so that
// the UPSERT ON CONFLICT finds the existing row instead of creating a duplicate.
console.log('\nTest 37: stability — same atom produces identical atom_key on two ingest calls');
{
  const payload = { atoms: [
    { rule_number: '505', title: 'Must Slide', body: BODY_A_FULL, source_ids: [ID_A] },
  ]};

  const [atoms1, atoms2] = await Promise.all([
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: makeMockClient(payload) }),
    extractRuleAtoms({ spans: [SPAN_A], spanIds: [ID_A], anthropicClient: makeMockClient(payload) }),
  ]);

  check('37a: atom_key identical across two calls',
        atoms1[0]?.atomKey === atoms2[0]?.atomKey,
        `run1="${atoms1[0]?.atomKey}" run2="${atoms2[0]?.atomKey}"`);
  check('37b: atom_key non-empty', Boolean(atoms1[0]?.atomKey));
}

// ── Test 38: Unnumbered atoms — atom_key is independent of array position ─────
// Old sequence-based keys ([Unnumbered-1], [Unnumbered-2]) depended on position.
// Content-derived keys must be the same for the same body regardless of position.
console.log('\nTest 38: stability — unnumbered atom_key stable across position changes');
{
  // Run 1: SPAN_A is at index 0, SPAN_B is at index 1
  const payload1 = { atoms: [
    { rule_number: '', title: 'Alpha', body: BODY_A_FULL, source_ids: [ID_A] },
    { rule_number: '', title: 'Beta',  body: BODY_B_FULL, source_ids: [ID_B] },
  ]};
  const run1 = await extractRuleAtoms({
    spans: [SPAN_A, SPAN_B], spanIds: [ID_A, ID_B],
    anthropicClient: makeMockClient(payload1),
  });

  // Run 2: SPAN_B first, SPAN_A second (reversed order)
  const payload2 = { atoms: [
    { rule_number: '', title: 'Beta',  body: BODY_B_FULL, source_ids: [ID_B] },
    { rule_number: '', title: 'Alpha', body: BODY_A_FULL, source_ids: [ID_A] },
  ]};
  const run2 = await extractRuleAtoms({
    spans: [SPAN_B, SPAN_A], spanIds: [ID_B, ID_A],
    anthropicClient: makeMockClient(payload2),
  });

  // BODY_A atom: run1[0] vs run2[1]  — should have the same atom_key
  // BODY_B atom: run1[1] vs run2[0]  — should have the same atom_key
  check('38a: BODY_A atom_key same regardless of position',
        run1[0]?.atomKey === run2[1]?.atomKey,
        `pos0="${run1[0]?.atomKey}" pos1="${run2[1]?.atomKey}"`);
  check('38b: BODY_B atom_key same regardless of position',
        run1[1]?.atomKey === run2[0]?.atomKey,
        `pos1="${run1[1]?.atomKey}" pos0="${run2[0]?.atomKey}"`);
  check('38c: both atom_keys start with "unnumbered#"',
        run1[0]?.atomKey?.startsWith('unnumbered#') &&
        run1[1]?.atomKey?.startsWith('unnumbered#'));
  check('38d: two different bodies produce different atom_keys',
        run1[0]?.atomKey !== run1[1]?.atomKey);
}

// ── Test 39: Whitespace/case/smart-quote differences do not change atom_key ───
// deriveAtomKey passes the source body through canonicalizeBody before hashing,
// so minor formatting variations in the source produce the same hash.
console.log('\nTest 39: stability — minor source formatting differences do not change atom_key');
{
  // Three bodies that differ only in whitespace / capitalisation / quotes
  // but are semantically identical after canonicalization.
  const bodyDoubleSpace = 'Rule 505.  Must Slide Rule.  A runner who does not slide is out.';
  const bodySingleSpace = 'Rule 505. Must Slide Rule. A runner who does not slide is out.';
  const bodyUpperCase   = 'RULE 505.  MUST SLIDE RULE.  A RUNNER WHO DOES NOT SLIDE IS OUT.';
  const bodySmartQuote  = 'Rule 505.\u2009Must Slide Rule.\u2009A runner who does not slide is out.'; // thin spaces

  const key1 = deriveAtomKey('505', bodyDoubleSpace);
  const key2 = deriveAtomKey('505', bodySingleSpace);
  const key3 = deriveAtomKey('505', bodyUpperCase);
  const key4 = deriveAtomKey('505', bodySmartQuote);

  check('39a: double-space == single-space → same atom_key',   key1 === key2,
        `"${key1}" vs "${key2}"`);
  check('39b: upper-case == lower-case → same atom_key',       key1 === key3,
        `"${key1}" vs "${key3}"`);
  check('39c: thin-space variant → same atom_key',             key1 === key4,
        `"${key1}" vs "${key4}"`);
  check('39d: all four keys are identical',                    new Set([key1, key2, key3, key4]).size === 1);

  // A body with a DIFFERENT word must produce a different atom_key.
  const bodyDifferentWord = 'Rule 505. Must Slide Rule. A player who does not slide is out.'; // "player" ≠ "runner"
  const key5 = deriveAtomKey('505', bodyDifferentWord);
  check('39e: different word → different atom_key',            key1 !== key5,
        `"${key1}" vs "${key5}"`);
}

// ── Test 40: canonicalizeBody unit tests ──────────────────────────────────────
// Directly verify the normalisation helper that feeds into deriveAtomKey.
console.log('\nTest 40: canonicalizeBody — normalisation unit checks');
{
  check('40a: collapses double spaces',
        canonicalizeBody('hello  world') === 'hello world');
  check('40b: lowercases',
        canonicalizeBody('HELLO WORLD') === 'hello world');
  check('40c: trims leading/trailing',
        canonicalizeBody('  hello  ') === 'hello');
  check('40d: collapses newline to space',
        canonicalizeBody('hello\nworld') === 'hello world');
  check('40e: collapses tab to space',
        canonicalizeBody('hello\tworld') === 'hello world');
  check('40f: smart left single quote → straight apostrophe',
        canonicalizeBody('it\u2018s') === "it's");
  check('40g: smart right single quote → straight apostrophe',
        canonicalizeBody('don\u2019t') === "don't");
  check('40h: smart double quotes → straight double quote',
        canonicalizeBody('\u201chello\u201d') === '"hello"');
  check('40i: en dash → hyphen',
        canonicalizeBody('one\u2013two') === 'one-two');
  check('40j: em dash → hyphen',
        canonicalizeBody('one\u2014two') === 'one-two');
  check('40k: empty string → empty string',
        canonicalizeBody('') === '');
  check('40l: only whitespace → empty string',
        canonicalizeBody('   \t\n  ') === '');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
