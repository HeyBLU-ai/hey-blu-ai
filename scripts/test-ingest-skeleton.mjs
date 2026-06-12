#!/usr/bin/env node
/**
 * scripts/test-ingest-skeleton.mjs
 *
 * Validates that all lib/ingest/ modules load without syntax errors and that
 * each exported function:
 *   - exists and is an async function
 *   - throws a useful Error (not silently resolves) when called with no args
 *
 * This script does NOT hit the database or any API.
 * It only exercises the argument-validation layer of the stubs.
 */

import {
  parseSource,
  createSourceSpans,
  extractRuleAtoms,
  verifyCoverage,
  writeRulebookVersion,
} from '../lib/ingest/index.mjs';

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

async function expectThrows(label, fn) {
  try {
    await fn();
    console.error(`  ✗ ${label} — did not throw`);
    failed++;
  } catch (e) {
    if (e instanceof Error && e.message.length > 10) {
      console.log(`  ✓ ${label} throws: "${e.message.slice(0, 80)}"`);
      passed++;
    } else {
      console.error(`  ✗ ${label} — threw but message too short or not an Error: ${e}`);
      failed++;
    }
  }
}

console.log('\n━━━  lib/ingest skeleton test  ━━━\n');

// ── Module-load check ────────────────────────────────────────────────────────
console.log('Module exports from lib/ingest/index.mjs:');
check('parseSource is a function',          typeof parseSource          === 'function');
check('createSourceSpans is a function',    typeof createSourceSpans    === 'function');
check('extractRuleAtoms is a function',     typeof extractRuleAtoms     === 'function');
check('verifyCoverage is a function',       typeof verifyCoverage       === 'function');
check('writeRulebookVersion is a function', typeof writeRulebookVersion === 'function');

// ── Async check ──────────────────────────────────────────────────────────────
console.log('\nAll exports are async (return Promise when called):');
const dummySpan  = { seq: 0, text: 'test span text' };
const dummyAtom  = { sourceSpanId: 'x', ruleId: '1', title: 't', quote: 'test span text', tags: [], judgment: false };
const dummyPool  = {};  // not a real pool — validation throws before DB is touched
// Minimal mock AI client — lets extractRuleAtoms run without a live API key.
const dummyAI    = {
  messages: { async create() { return { content: [{ text: '{"atoms":[]}' }] }; } },
};

check('parseSource() returns a Promise',
  parseSource({ text: 'hello' }) instanceof Promise);

check('createSourceSpans() returns a Promise',
  createSourceSpans({ db: dummyPool, versionId: 'v1', spans: [dummySpan] }) instanceof Promise);

check('extractRuleAtoms() returns a Promise',
  extractRuleAtoms({ spans: [dummySpan], spanIds: ['id1'], anthropicClient: dummyAI }) instanceof Promise);

check('verifyCoverage() returns a Promise',
  verifyCoverage({ spans: [dummySpan], atoms: [dummyAtom], spanIds: ['id1'] }) instanceof Promise);

check('writeRulebookVersion() returns a Promise',
  writeRulebookVersion({
    db: dummyPool, leagueId: 'l1', label: 'test', sourceFileName: 'test.txt',
    spans: [dummySpan], atoms: [],
  }) instanceof Promise);

// ── Argument-validation (throw on bad input) ─────────────────────────────────
console.log('\nArgument validation — each function throws on missing required args:');

await expectThrows('parseSource() with no args',
  () => parseSource());

await expectThrows('createSourceSpans() with no db',
  () => createSourceSpans({ versionId: 'v1', spans: [dummySpan] }));

await expectThrows('createSourceSpans() with no versionId',
  () => createSourceSpans({ db: dummyPool, spans: [dummySpan] }));

await expectThrows('createSourceSpans() with empty spans',
  () => createSourceSpans({ db: dummyPool, versionId: 'v1', spans: [] }));

await expectThrows('extractRuleAtoms() with no spans',
  () => extractRuleAtoms({ spanIds: [] }));

await expectThrows('extractRuleAtoms() mismatched spanIds length',
  () => extractRuleAtoms({ spans: [dummySpan], spanIds: [] }));

await expectThrows('verifyCoverage() with no spans',
  () => verifyCoverage({ atoms: [], spanIds: [] }));

await expectThrows('verifyCoverage() with no spanIds',
  () => verifyCoverage({ spans: [dummySpan], atoms: [] }));

await expectThrows('writeRulebookVersion() with no db',
  () => writeRulebookVersion({ leagueId: 'l1', label: 'L', sourceFileName: 'f', spans: [dummySpan], atoms: [] }));

await expectThrows('writeRulebookVersion() with no leagueId',
  () => writeRulebookVersion({ db: dummyPool, label: 'L', sourceFileName: 'f', spans: [dummySpan], atoms: [] }));

await expectThrows('writeRulebookVersion() with empty spans',
  () => writeRulebookVersion({ db: dummyPool, leagueId: 'l1', label: 'L', sourceFileName: 'f', spans: [], atoms: [] }));

// ── Stub return shapes ────────────────────────────────────────────────────────
console.log('\nStub return shapes:');

const spanResult = await parseSource({ text: 'some text' });
check('parseSource stub returns array',           Array.isArray(spanResult));
check('parseSource stub array has at least 1',    spanResult.length >= 1);
check('parseSource stub span has seq + text',     typeof spanResult[0]?.seq === 'number' && typeof spanResult[0]?.text === 'string');

const spanInsert = await createSourceSpans({ db: dummyPool, versionId: 'v1', spans: [dummySpan] });
check('createSourceSpans stub returns { inserted }', typeof spanInsert?.inserted === 'number');

const atoms = await extractRuleAtoms({ spans: [dummySpan], spanIds: ['id1'], anthropicClient: dummyAI });
check('extractRuleAtoms returns array',            Array.isArray(atoms));

const report = await verifyCoverage({ spans: [dummySpan], atoms: [], spanIds: ['id1'] });
check('verifyCoverage stub .ok is boolean',        typeof report?.ok === 'boolean');
check('verifyCoverage stub .issues is array',      Array.isArray(report?.issues));

const vr = await writeRulebookVersion({
  db: dummyPool, leagueId: 'l1', label: 'L', sourceFileName: 'f.txt',
  spans: [dummySpan], atoms: [],
});
check('writeRulebookVersion stub .versionId is string', typeof vr?.versionId === 'string');
check('writeRulebookVersion stub .status === "draft"',  vr?.status === 'draft');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
