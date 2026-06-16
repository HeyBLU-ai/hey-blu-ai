#!/usr/bin/env node
/**
 * Local smoke test for POST /api/admin/ingest (auth + validation only).
 *   node scripts/smoke-admin-ingest.mjs
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of (await fs.readFile(path.join(__dirname, '../.env.local'), 'utf8')).split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

async function call(handler, req) {
  let status = 0;
  let json = {};
  const res = {
    status(code) { status = code; return this; },
    json(payload) { json = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await handler(req, res);
  return { status, body: json };
}

const { default: ingest } = await import('../api/admin/ingest.js');

const noAuth = await call(ingest, { method: 'POST', headers: {}, body: {} });
const badJson = await call(ingest, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.ADMIN_PASSWORD}` },
  body: { league_slug: 'bad slug', file_base64: '' },
});

console.log('no auth:', noAuth.status, noAuth.body);
console.log('bad slug:', badJson.status, badJson.body);

const ok = noAuth.status === 401 && badJson.status === 400;
if (!ok) process.exit(1);
console.log('\n✓ Admin ingest auth/validation smoke test passed');
