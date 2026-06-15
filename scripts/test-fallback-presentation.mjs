#!/usr/bin/env node
/**
 * Smoke test: fallback citation prefix + disclaimer metadata.
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

const { default: handler } = await import('../api/ask-v2.js');

const QUESTIONS = [
  'catcher interfered with the batter during a checked swing what is the call',
  "what is catcher's interference",
];

async function call(body) {
  const req = { method: 'POST', headers: {}, body };
  let status = 0;
  let json = {};
  const res = {
    status(code) { status = code; return this; },
    json(payload) { json = payload; return this; },
    setHeader() { return this; },
  };
  await handler(req, res);
  return { status, body: json };
}

console.log('Testing fallback presentation fixes...\n');

let res = null;
for (const question of QUESTIONS) {
  console.log('Trying:', question);
  res = await call({ question, league: 'bamsbl', conversation: [], force_rag: true });
  console.log('  ->', res.body.state);
  if (res.body.state === 'answered' && res.body.usedFallback) break;
}

console.log('state:', res.body.state);
console.log('usedFallback:', res.body.usedFallback);
console.log('league_website_url:', res.body.league_website_url);
console.log('fallback_league_website_url:', res.body.fallback_league_website_url);

const reply = res.body.reply ?? '';
const bookSection = reply.split('**The Book:**')[1] ?? '';
console.log('\nThe Book preview:', bookSection.slice(0, 220).replace(/\n/g, ' '));

const checks = [
  ['answered', res.body.state === 'answered'],
  ['usedFallback true', res.body.usedFallback === true],
  ['MLB citation prefix', /MLB Official Rule/i.test(reply)],
  ['no generic Official Rule without MLB', !/\*\*Official Rule \d/i.test(reply)],
  ['no LLM fallback notice', !/Fallback Notice:/i.test(reply)],
  ['no duplicate official rulebook phrase', !/official rulebook and official rulebook/i.test(reply)],
  ['BAMSBL has no website url', res.body.league_website_url == null],
  ['MLB fallback website url present', typeof res.body.fallback_league_website_url === 'string' && res.body.fallback_league_website_url.startsWith('http')],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}

if (failed) process.exit(1);
console.log('\n✓ Presentation smoke test passed');
