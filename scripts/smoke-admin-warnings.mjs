/**
 * Smoke test for /api/admin/warnings (run while vercel dev is up).
 * Usage: node scripts/smoke-admin-warnings.mjs
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API_BASE ?? 'http://localhost:3000';

try {
  for (const line of readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] ??= v;
  }
} catch { /* */ }

const pw = process.env.ADMIN_PASSWORD;
if (!pw) {
  console.error('ADMIN_PASSWORD missing from .env.local');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${pw}` };

console.log(`GET ${BASE}/api/admin/warnings`);
const getRes = await fetch(`${BASE}/api/admin/warnings`, { headers });
const getBody = await getRes.json().catch(() => ({}));
console.log('  status:', getRes.status);
console.log('  total:', getBody.total ?? getBody.error);

const badRes = await fetch(`${BASE}/api/admin/warnings`, {
  headers: { Authorization: 'Bearer wrong-password' },
});
console.log('Unauthorized check:', badRes.status, badRes.status === 401 ? 'OK' : 'FAIL');

if (getRes.status !== 200) {
  console.error('GET failed:', JSON.stringify(getBody, null, 2));
  process.exit(1);
}

console.log('Smoke test passed.');
