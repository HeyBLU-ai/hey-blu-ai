#!/usr/bin/env node
/**
 * scripts/test-parse-url.mjs
 *
 * Tests the URL extraction path in lib/ingest/parse-source.mjs.
 *
 * Strategy:
 *   All tests mock globalThis.fetch so there are no real network calls.
 *   This makes the suite deterministic, fast, and offline-safe.
 *
 * Assertions:
 *   Test 1 — Happy path (200 OK, multi-paragraph markdown)
 *     1a. Resolves without throwing.
 *     1b. Returns a non-empty array.
 *     1c. Each span has seq (number), text (non-empty), page (null), sourceUrl (string).
 *     1d. charStart < charEnd.
 *     1e. Spans ordered by seq 0,1,2,…
 *     1f. The Jina Reader URL sent to fetch is r.jina.ai/<original url>.
 *     1g. Content from the mock markdown appears in at least one span.
 *
 *   Test 2 — 404 response → throws descriptive error.
 *
 *   Test 3 — 500 response → throws descriptive error.
 *
 *   Test 4 — Network error → throws descriptive error.
 *
 *   Test 5 — Empty response body → throws descriptive error.
 *
 *   Test 6 — Timeout → throws descriptive error.
 *     (Simulated by returning a never-resolving promise and setting timeoutMs=1.)
 *
 *   Test 7 — Regression: parseSource() with no args still throws.
 */

import { parseSource } from '../lib/ingest/parse-source.mjs';

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

async function expectThrows(label, fn, msgFragment = '') {
  try {
    await fn();
    console.error(`  ✗ ${label} — did not throw`);
    failed++;
  } catch (e) {
    const ok = e instanceof Error && e.message.length > 10 &&
               (!msgFragment || e.message.toLowerCase().includes(msgFragment.toLowerCase()));
    check(label + (msgFragment ? ` (msg contains "${msgFragment}")` : ''), ok,
          ok ? '' : `got: "${e.message.slice(0, 120)}"`);
  }
}

/** Save and restore globalThis.fetch around a test. */
async function withMockedFetch(mockFn, testFn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  try {
    await testFn();
  } finally {
    globalThis.fetch = original;
  }
}

const TEST_URL      = 'https://example-league.com/2026-rules';
const MOCK_MARKDOWN = [
  'Title: Bay Area League 2026 Rules',
  '',
  'Rule 505: No-collision rule. A runner approaching home plate must slide or divert course to avoid collision with the catcher.',
  '',
  'Rule 506: Obstruction. A fielder without possession who impedes a runner commits obstruction and the umpire shall award bases accordingly.',
  '',
  'Rule 507: Mound visits. Each team is limited to five mound visits per nine innings without removing the pitcher from the game.',
].join('\n');

console.log('\n━━━  parse-source URL extraction test  ━━━\n');

// ── Test 1: Happy path ────────────────────────────────────────────────────────
console.log('Test 1: 200 OK — multi-paragraph markdown');

let capturedFetchUrl;
await withMockedFetch(
  async (url, init) => {
    capturedFetchUrl = url;
    return { ok: true, status: 200, text: async () => MOCK_MARKDOWN };
  },
  async () => {
    let spans;
    try {
      spans = await parseSource({ url: TEST_URL });
      check('1a: resolves without throwing',   true);
    } catch (e) {
      check('1a: resolves without throwing',   false, e.message);
      console.error('\nFull error:', e);
      return;
    }

    check('1b: returns non-empty array',       Array.isArray(spans) && spans.length > 0, `got ${spans?.length}`);
    check('1f: fetch URL is r.jina.ai/<url>',  capturedFetchUrl === `https://r.jina.ai/${TEST_URL}`,
          `got: ${capturedFetchUrl}`);

    for (const span of spans) {
      check(`1c[${span.seq}] seq is number`,       typeof span.seq  === 'number' && span.seq >= 0);
      check(`1c[${span.seq}] text non-empty`,       typeof span.text === 'string' && span.text.trim().length > 0);
      check(`1c[${span.seq}] page is null`,         span.page === null,     `got ${span.page}`);
      check(`1c[${span.seq}] sourceUrl is the URL`, span.sourceUrl === TEST_URL, `got ${span.sourceUrl}`);
      check(`1d[${span.seq}] charStart < charEnd`,  span.charStart < span.charEnd,
            `${span.charStart}..${span.charEnd}`);
    }

    const seqs = spans.map(s => s.seq);
    check('1e: spans ordered by seq 0,1,2,…',  seqs.every((v, i) => v === i), `seqs: ${seqs}`);

    const allText = spans.map(s => s.text).join(' ');
    check('1g: Rule 505 text appears in spans', allText.includes('Rule 505'), `text: "${allText.slice(0, 120)}"`);

    console.log(`\n  Spans returned: ${spans.length}`);
    for (const s of spans) {
      console.log(`    seq=${s.seq} chars=${s.charStart}..${s.charEnd} text="${s.text.slice(0, 80)}"`);
    }
  },
);

// ── Test 2: 404 → throws ─────────────────────────────────────────────────────
console.log('\nTest 2: 404 response → throws with HTTP status in message');
await withMockedFetch(
  async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' }),
  () => expectThrows('2: 404 throws', () => parseSource({ url: TEST_URL }), '404'),
);

// ── Test 3: 500 → throws ─────────────────────────────────────────────────────
console.log('\nTest 3: 500 response → throws with HTTP status in message');
await withMockedFetch(
  async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '' }),
  () => expectThrows('3: 500 throws', () => parseSource({ url: TEST_URL }), '500'),
);

// ── Test 4: network error → throws ───────────────────────────────────────────
console.log('\nTest 4: network error → throws with "network error" in message');
await withMockedFetch(
  async () => { throw new TypeError('fetch failed — ECONNREFUSED'); },
  () => expectThrows('4: network error throws', () => parseSource({ url: TEST_URL }), 'network error'),
);

// ── Test 5: empty body → throws ──────────────────────────────────────────────
console.log('\nTest 5: empty response body → throws "empty content"');
await withMockedFetch(
  async () => ({ ok: true, status: 200, text: async () => '   ' }),
  () => expectThrows('5: empty body throws', () => parseSource({ url: TEST_URL }), 'empty'),
);

// ── Test 6: timeout → throws ─────────────────────────────────────────────────
console.log('\nTest 6: timeout (timeoutMs=1) → throws "timed out"');
await withMockedFetch(
  // Returns a promise that never settles — simulates a hung server.
  async (url, init) => new Promise((_resolve, _reject) => {
    init?.signal?.addEventListener('abort', () =>
      _reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    );
  }),
  () => expectThrows(
    '6: timeout throws',
    () => parseSource({ url: TEST_URL, timeoutMs: 1 }),
    'timed out',
  ),
);

// ── Test 7: no-args regression ────────────────────────────────────────────────
console.log('\nTest 7: parseSource() with no args still throws (regression)');
try {
  await parseSource();
  check('7: throws on no args', false, 'did not throw');
} catch (e) {
  check('7: throws on no args', e instanceof Error && e.message.length > 10);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
