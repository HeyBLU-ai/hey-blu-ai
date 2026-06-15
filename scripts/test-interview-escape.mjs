#!/usr/bin/env node
/**
 * Smoke test: interview escape hatch via force_rag.
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

const QUESTION = "catcher interfered with the batter during a checked swing what is the call";
const LEAGUE = 'bamsbl';

async function postViaHandler(body) {
  const { default: handler } = await import('../api/ask-v2.js');
  const req = { method: 'POST', body, headers: {} };
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

async function postViaHttp(body) {
  const BASE = (process.env.ASK_URL ?? 'http://localhost:3000') + '/api/ask-v2';
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const post = process.env.USE_HTTP === '1' ? postViaHttp : postViaHandler;

console.log('Question:', QUESTION);
console.log('League:', LEAGUE);
console.log('Mode:', process.env.USE_HTTP === '1' ? 'http' : 'direct handler');

const routed = await post({ question: QUESTION, league: LEAGUE, conversation: [] });
console.log('\n1) Without force_rag:', routed.status, routed.body.state, routed.body.matrix_id ?? '');

const escaped = await post({
  question: QUESTION,
  league: LEAGUE,
  conversation: [],
  force_rag: true,
});
console.log('\n2) With force_rag (original question):', escaped.status, escaped.body.state);
console.log('   usedFallback:', escaped.body.usedFallback);
console.log('   fallbackLeague:', escaped.body.fallbackLeague);
console.log('   cited:', escaped.body.cited_rule_numbers);
console.log('   reply preview:', (escaped.body.reply ?? escaped.body.message ?? '').slice(0, 220).replace(/\n/g, ' '));

const direct = await post({
  question: "what is catcher's interference",
  league: LEAGUE,
  conversation: [],
  force_rag: true,
});
console.log('\n3) With force_rag (definitional):', direct.status, direct.body.state);
console.log('   usedFallback:', direct.body.usedFallback);
console.log('   fallbackLeague:', direct.body.fallbackLeague);
console.log('   cited:', direct.body.cited_rule_numbers);
console.log('   reply preview:', (direct.body.reply ?? '').slice(0, 220).replace(/\n/g, ' '));

const routingOk =
  routed.status === 200 &&
  routed.body.state === 'needs_clarification' &&
  escaped.status === 200 &&
  escaped.body.state !== 'needs_clarification';

const ragOk =
  direct.status === 200 &&
  direct.body.state === 'answered' &&
  direct.body.usedFallback === true &&
  /interference|catcher/i.test(direct.body.reply ?? '');

if (!routingOk) {
  console.error('\n✗ Escape hatch routing test failed (force_rag still hit decision tree)');
  process.exit(1);
}

if (!ragOk) {
  console.error('\n✗ MLB fallback RAG test failed for catcher interference');
  process.exit(1);
}

console.log('\n✓ Escape hatch smoke test passed');
