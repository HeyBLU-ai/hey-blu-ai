#!/usr/bin/env node
/**
 * Smoke test for GET /api/get-leagues
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import handler from '../api/get-leagues.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

let status = 0;
let body = null;
const res = {
  setHeader() {},
  status(code) { status = code; return res; },
  json(payload) { body = payload; return res; },
  end() { return res; },
};

await handler({ method: 'GET' }, res);

if (status !== 200) {
  console.error('Expected 200, got', status, body);
  process.exit(1);
}

const slugs = (body.leagues ?? []).map((l) => l.slug);
console.log('Active leagues:', slugs.join(', '));

if (!slugs.includes('nsll-minors-aaa')) {
  console.error('nsll-minors-aaa missing from active leagues');
  process.exit(1);
}

console.log('✓ get-leagues includes nsll-minors-aaa');
