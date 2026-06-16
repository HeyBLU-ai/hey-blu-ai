/**
 * Smoke test: /api/admin/ingest requires auth and rejects empty POSTs.
 *
 * Usage:
 *   npm run smoke:legacy-ingest-disabled
 *
 * Environment:
 *   ASK_API_URL  — base URL to test against (default: https://heyblu.ai)
 */

const BASE = (process.env.ASK_API_URL ?? 'https://heyblu.ai').replace(/\/$/, '');
const TARGET = `${BASE}/api/admin/ingest`;

console.log(`\nSmoke test: admin DOCX ingest auth gate`);
console.log(`  Target : ${TARGET}`);

let status;
let body;
try {
  const res = await fetch(TARGET, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ league_slug: 'test-league' }),
  });
  status = res.status;
  body = await res.json().catch(() => ({}));
  console.log(`  HTTP   : ${status}`);
  console.log(`  Body   :`, body);
} catch (err) {
  console.error(`  FAIL — network error: ${err.message}`);
  process.exit(1);
}

if (status === 401 && body?.error === 'Unauthorized') {
  console.log(`  PASS   — ${status} confirms ingest endpoint is live and password-gated.\n`);
  process.exit(0);
}

console.error(
  `  FAIL   — expected 401 Unauthorized, got ${status}.\n` +
  `           Response: ${JSON.stringify(body)}\n`,
);
process.exit(1);
