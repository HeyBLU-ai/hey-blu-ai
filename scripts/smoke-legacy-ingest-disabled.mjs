/**
 * Smoke test: /api/admin/ingest must never return HTTP 200.
 *
 * Asserts that the endpoint responds with 404 or 410 (Gone), proving that
 * the legacy summarisation ingest pipeline cannot be reached in production.
 *
 * Usage:
 *   npm run smoke:legacy-ingest-disabled
 *
 * Environment:
 *   ASK_API_URL  — base URL to test against (default: https://heyblu.ai)
 */

const BASE = (process.env.ASK_API_URL ?? 'https://heyblu.ai').replace(/\/$/, '');
const TARGET = `${BASE}/api/admin/ingest`;

console.log(`\nSmoke test: legacy ingest disabled`);
console.log(`  Target : ${TARGET}`);

let status;
try {
  const res = await fetch(TARGET, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ url: 'https://example.com', leagueSlug: 'bamsbl' }),
  });
  status = res.status;
  console.log(`  HTTP   : ${status}`);
} catch (err) {
  console.error(`  FAIL — network error: ${err.message}`);
  process.exit(1);
}

if (status === 404 || status === 410) {
  console.log(`  PASS   — ${status} confirms legacy ingest is disabled.\n`);
  process.exit(0);
} else {
  console.error(
    `  FAIL   — expected 404 or 410, got ${status}.\n` +
    `           The legacy ingest endpoint may still be active.\n`,
  );
  process.exit(1);
}
