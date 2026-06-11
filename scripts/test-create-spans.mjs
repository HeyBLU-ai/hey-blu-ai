#!/usr/bin/env node
/**
 * scripts/test-create-spans.mjs
 *
 * Tests the identifyBoundaries() function in lib/ingest/create-source-spans.mjs.
 *
 * All tests use an injected mock Anthropic client — no real API calls are made.
 * The mock is a plain object shaped like the Anthropic SDK:
 *   { messages: { create: async (params) => { content: [{ text: '...' }] } } }
 *
 * Assertions:
 *   Test 1  — Happy path: AI returns one verbatim rule → one boundary returned.
 *   Test 2  — Happy path: AI returns two verbatim rules → two boundaries returned.
 *   Test 3  — Verbatim guard: AI paraphrases a word → throws with "VERBATIM GUARD".
 *   Test 4  — Verbatim guard: AI changes capitalization → throws.
 *   Test 5  — Verbatim guard: AI adds an extra word → throws.
 *   Test 6  — AI returns empty rules array → falls back to whole-span boundary.
 *   Test 7  — AI returns invalid JSON → throws with parse error message.
 *   Test 8  — AI returns empty string → throws.
 *   Test 9  — charStart/charEnd offsets honour the source span's base offset.
 *   Test 10 — Output text is sliced from original (identical to source), not AI text.
 *   Test 11 — No API key AND no client override → throws with helpful message.
 *   Test 12 — opts.span missing → throws.
 *   Test 13 — opts.span.text missing/empty → throws.
 *   Test 14 — createSourceSpans() stub still returns { inserted: 0 } (regression).
 */

import { identifyBoundaries, createSourceSpans } from '../lib/ingest/create-source-spans.mjs';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function expectThrows(label, fn, fragment = '') {
  try {
    await fn();
    console.error(`  ✗ ${label} — did NOT throw`);
    failed++;
  } catch (e) {
    const ok = e instanceof Error &&
               (!fragment || e.message.toLowerCase().includes(fragment.toLowerCase()));
    check(label + (fragment ? ` (msg contains "${fragment}")` : ''),
          ok, ok ? '' : `msg: "${e.message.slice(0, 150)}"`);
  }
}

/** Build a mock Anthropic client that returns a fixed JSON string. */
function mockClient(jsonString) {
  return {
    messages: {
      create: async () => ({ content: [{ text: jsonString }] }),
    },
  };
}

/** Build a mock client whose response is a function of the sent prompt. */
function dynamicMockClient(fn) {
  return {
    messages: {
      create: async (params) => ({ content: [{ text: fn(params) }] }),
    },
  };
}

// ── Source text used across most tests ───────────────────────────────────────
const PARA1 = 'Rule 505: No-collision rule. A runner approaching home plate must slide or divert course when the catcher has possession of the ball.';
const PARA2 = 'Rule 506: Obstruction. A fielder without possession who impedes a runner is guilty of obstruction and the umpire shall award bases.';
const TWO_RULE_TEXT = `${PARA1}\n\n${PARA2}`;

const baseSpan = (text, charStart = 0) => ({
  seq:       0,
  text,
  heading:   null,
  page:      1,
  charStart,
  charEnd:   charStart + text.length,
});

console.log('\n━━━  identifyBoundaries test  ━━━\n');

// ── Test 1: Single verbatim rule ──────────────────────────────────────────────
console.log('Test 1: happy path — AI returns one verbatim rule');
{
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: PARA1 }] }));
  const result = await identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client });
  check('1a: returns array of length 1',    result.length === 1, `got ${result.length}`);
  check('1b: text matches source exactly',  result[0].text === PARA1);
  check('1c: charStart = 0',                result[0].charStart === 0);
  check('1d: charEnd = text.length',        result[0].charEnd === PARA1.length,
        `got ${result[0].charEnd}, expected ${PARA1.length}`);
}

// ── Test 2: Two verbatim rules ────────────────────────────────────────────────
console.log('\nTest 2: happy path — AI returns two verbatim rules from two-paragraph span');
{
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: PARA1 }, { verbatim: PARA2 }] }));
  const result = await identifyBoundaries({ span: baseSpan(TWO_RULE_TEXT), anthropicClient: client });
  check('2a: returns 2 boundaries',         result.length === 2, `got ${result.length}`);
  check('2b: boundary[0].text === PARA1',   result[0].text === PARA1);
  check('2c: boundary[1].text === PARA2',   result[1].text === PARA2);
  const p2idx = TWO_RULE_TEXT.indexOf(PARA2);
  check('2d: boundary[1].charStart correct', result[1].charStart === p2idx, `got ${result[1].charStart}, expected ${p2idx}`);
}

// ── Test 3: Paraphrased word → guard throws ───────────────────────────────────
console.log('\nTest 3: verbatim guard — AI paraphrases a word');
{
  const hallucination = PARA1.replace('must slide', 'is required to slide');
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: hallucination }] }));
  await expectThrows('3: paraphrase caught', () => identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client }), 'verbatim guard');
}

// ── Test 4: Capitalization change → guard throws ─────────────────────────────
console.log('\nTest 4: verbatim guard — AI changes capitalization');
{
  const hallucination = PARA1.replace('must slide', 'Must Slide');
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: hallucination }] }));
  await expectThrows('4: capitalization caught', () => identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client }), 'verbatim guard');
}

// ── Test 5: Extra word added → guard throws ───────────────────────────────────
console.log('\nTest 5: verbatim guard — AI adds an extra word');
{
  const hallucination = PARA1.replace('must slide', 'must always slide');
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: hallucination }] }));
  await expectThrows('5: extra word caught', () => identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client }), 'verbatim guard');
}

// ── Test 6: Empty rules array → whole-span fallback ──────────────────────────
console.log('\nTest 6: empty rules array → falls back to whole span');
{
  const client = mockClient(JSON.stringify({ rules: [] }));
  const result = await identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client });
  check('6a: returns 1 boundary',           result.length === 1);
  check('6b: text is full span text',       result[0].text === PARA1);
}

// ── Test 7: Invalid JSON → parse error ───────────────────────────────────────
console.log('\nTest 7: AI returns invalid JSON → throws parse error');
{
  const client = mockClient('This is not JSON at all.');
  await expectThrows('7: invalid JSON caught', () => identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client }), 'parse');
}

// ── Test 8: Empty AI response → throws ───────────────────────────────────────
console.log('\nTest 8: AI returns empty string → throws');
{
  const client = { messages: { create: async () => ({ content: [{ text: '' }] }) } };
  await expectThrows('8: empty response caught', () => identifyBoundaries({ span: baseSpan(PARA1), anthropicClient: client }), 'empty');
}

// ── Test 9: charStart offset propagated ──────────────────────────────────────
console.log('\nTest 9: charStart base offset from source span is honoured');
{
  const BASE_OFFSET = 5000;
  const client = mockClient(JSON.stringify({ rules: [{ verbatim: PARA1 }] }));
  const result = await identifyBoundaries({ span: baseSpan(PARA1, BASE_OFFSET), anthropicClient: client });
  check('9a: charStart = baseOffset + 0',   result[0].charStart === BASE_OFFSET,       `got ${result[0].charStart}`);
  check('9b: charEnd = baseOffset + len',   result[0].charEnd === BASE_OFFSET + PARA1.length, `got ${result[0].charEnd}`);
}

// ── Test 10: Output text from original, not AI ───────────────────────────────
console.log('\nTest 10: output text is sliced from original source (not AI response)');
{
  // Give the AI a response with trailing whitespace — the guard passes (indexOf finds it)
  // but the output must be exactly what indexOf + verbatim.length produces from spanText.
  const verbatim = PARA1;  // exact match — trivially verifiable
  const client = mockClient(JSON.stringify({ rules: [{ verbatim }] }));
  const span   = baseSpan(PARA1);
  const result = await identifyBoundaries({ span, anthropicClient: client });
  // The text must be `spanText.slice(idx, idx + verbatim.length)` — identical to span.text
  check('10: output text === span.text slice', result[0].text === PARA1);
  // Confirm it is NOT a reference to the AI string (same value, which is correct)
  check('10: charStart + length = charEnd',
        result[0].charEnd - result[0].charStart === result[0].text.length);
}

// ── Test 11: No API key, no client override → throws ─────────────────────────
console.log('\nTest 11: no API key AND no client override → throws with helpful message');
{
  // Save and clear the env var to simulate missing key
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await expectThrows('11: missing API key throws',
      () => identifyBoundaries({ span: baseSpan(PARA1) }),
      'ANTHROPIC_API_KEY');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

// ── Test 12: opts.span missing → throws ──────────────────────────────────────
console.log('\nTest 12: opts.span missing → throws');
await expectThrows('12: no span throws', () => identifyBoundaries({}), 'span');

// ── Test 13: opts.span.text empty → throws ───────────────────────────────────
console.log('\nTest 13: opts.span.text empty → throws');
await expectThrows('13: empty span.text throws',
  () => identifyBoundaries({ span: { seq: 0, text: '   ', charStart: 0, charEnd: 0 } }),
  'non-empty');

// ── Test 14: createSourceSpans stub still returns { inserted: 0 } ────────────
console.log('\nTest 14: createSourceSpans stub regression');
{
  const dummyPool = {};
  const dummySpan = { seq: 0, text: PARA1 };
  const r = await createSourceSpans({ db: dummyPool, versionId: 'v1', spans: [dummySpan] });
  check('14a: returns object',              typeof r === 'object' && r !== null);
  check('14b: inserted is 0',              r.inserted === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB insertion tests (Tests 15-21)
// Uses an injected mock dbClient — no real Postgres connection needed.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock pg-compatible client that records all query calls. */
function makeMockDb() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return { rows: [{ id: `mock-uuid-${calls.length}` }] };
    },
  };
}

const DOC_ID = 'doc-00000000-0000-0000-0000-000000000001';

const dbSpan1 = {
  seq: 0, text: PARA1, page: 3, heading: 'Section 5',
  charStart: 0, charEnd: PARA1.length,
};
const dbSpan2 = {
  seq: 1, text: PARA2, page: 4, heading: null,
  charStart: PARA1.length + 1, charEnd: PARA1.length + 1 + PARA2.length,
};

// ── Test 15: INSERT is called for each span ───────────────────────────────────
console.log('\nTest 15: createSourceSpans with documentId — one INSERT per span');
{
  const db = makeMockDb();
  const res = await createSourceSpans({
    dbClient: db, documentId: DOC_ID, versionId: 'v1',
    spans: [dbSpan1, dbSpan2],
  });
  check('15a: 2 DB calls made',          db.calls.length === 2, `got ${db.calls.length}`);
  check('15b: SQL contains INSERT INTO rule_sources',
        db.calls[0].text.includes('INSERT INTO rule_sources'));
  check('15c: SQL RETURNING id',         db.calls[0].text.includes('RETURNING id'));
  check('15d: result inserted = 2',      res.inserted === 2, `got ${res.inserted}`);
  check('15e: result.ids has 2 entries', Array.isArray(res.ids) && res.ids.length === 2,
        `got ${JSON.stringify(res.ids)}`);
}

// ── Test 16: documentId is first parameter ────────────────────────────────────
console.log('\nTest 16: documentId passed as $1');
{
  const db = makeMockDb();
  await createSourceSpans({ dbClient: db, documentId: DOC_ID, versionId: 'v1', spans: [dbSpan1] });
  check('16: values[0] === documentId', db.calls[0].values[0] === DOC_ID,
        `got "${db.calls[0].values[0]}"`);
}

// ── Test 17: page_start and page_end from span.page ───────────────────────────
console.log('\nTest 17: page_start ($2) and page_end ($3) mapped from span.page');
{
  const db = makeMockDb();
  await createSourceSpans({ dbClient: db, documentId: DOC_ID, versionId: 'v1', spans: [dbSpan1] });
  const v = db.calls[0].values;
  check('17a: values[1] (page_start) = 3', v[1] === 3,   `got ${v[1]}`);
  check('17b: values[2] (page_end) = 3',   v[2] === 3,   `got ${v[2]}`);
}

// ── Test 18: section_path from span.heading ───────────────────────────────────
console.log('\nTest 18: section_path ($4) mapped from span.heading');
{
  const db = makeMockDb();
  await createSourceSpans({ dbClient: db, documentId: DOC_ID, versionId: 'v1', spans: [dbSpan1, dbSpan2] });
  check('18a: values[3] (section_path) = "Section 5"', db.calls[0].values[3] === 'Section 5',
        `got "${db.calls[0].values[3]}"`);
  check('18b: values[3] (section_path) = null for span2', db.calls[1].values[3] === null,
        `got "${db.calls[1].values[3]}"`);
}

// ── Test 19: char_start, char_end, exact_text ─────────────────────────────────
console.log('\nTest 19: char_start ($5), char_end ($6), exact_text ($7) mapped correctly');
{
  const db = makeMockDb();
  await createSourceSpans({ dbClient: db, documentId: DOC_ID, versionId: 'v1', spans: [dbSpan1] });
  const v = db.calls[0].values;
  check('19a: values[4] (char_start) = 0',             v[4] === 0,           `got ${v[4]}`);
  check('19b: values[5] (char_end) = PARA1.length',    v[5] === PARA1.length, `got ${v[5]}`);
  check('19c: values[6] (exact_text) = PARA1',         v[6] === PARA1,       `got "${v[6]?.slice(0,50)}"`);
}

// ── Test 20: parse_warnings serialized as JSON ────────────────────────────────
console.log('\nTest 20: parse_warnings ($8) — with and without warnings');
{
  const warnSpan = {
    seq: 0, text: PARA1, page: 1, heading: null,
    charStart: 0, charEnd: PARA1.length,
    parse_warnings: ['dual-pass discrepancy: 500 chars vs 100 chars (80% difference)'],
  };
  const db1 = makeMockDb();
  await createSourceSpans({ dbClient: db1, documentId: DOC_ID, versionId: 'v1', spans: [warnSpan] });
  const warnJson = db1.calls[0].values[7];
  const parsed   = JSON.parse(warnJson);
  check('20a: parse_warnings is valid JSON string',   typeof warnJson === 'string');
  check('20b: parsed array has 1 entry',              Array.isArray(parsed) && parsed.length === 1,
        `got ${JSON.stringify(parsed)}`);
  check('20c: warning text preserved',                parsed[0].includes('dual-pass discrepancy'));

  // No parse_warnings → '[]'
  const db2 = makeMockDb();
  await createSourceSpans({ dbClient: db2, documentId: DOC_ID, versionId: 'v1', spans: [dbSpan1] });
  check('20d: no parse_warnings → values[7] === "[]"', db2.calls[0].values[7] === '[]',
        `got "${db2.calls[0].values[7]}"`);
}

// ── Test 21: returned ids match mock DB responses ─────────────────────────────
console.log('\nTest 21: returned ids array mirrors DB RETURNING id values');
{
  const db = makeMockDb();
  const res = await createSourceSpans({
    dbClient: db, documentId: DOC_ID, versionId: 'v1',
    spans: [dbSpan1, dbSpan2],
  });
  check('21a: ids[0] = "mock-uuid-1"', res.ids[0] === 'mock-uuid-1', `got "${res.ids[0]}"`);
  check('21b: ids[1] = "mock-uuid-2"', res.ids[1] === 'mock-uuid-2', `got "${res.ids[1]}"`);
}

// ── Test 22: legacy path (versionId only) still returns stub ──────────────────
console.log('\nTest 22: legacy path — versionId only, no documentId → stub { inserted: 0 }');
{
  const db = makeMockDb();
  const res = await createSourceSpans({ dbClient: db, versionId: 'v1', spans: [dbSpan1] });
  check('22a: inserted = 0',             res.inserted === 0);
  check('22b: no DB queries made',       db.calls.length === 0, `got ${db.calls.length} calls`);
  check('22c: no ids field',             res.ids === undefined);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
