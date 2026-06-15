#!/usr/bin/env node
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

const { default: submitFeedback } = await import('../api/submit-feedback.js');
const { default: adminFeedback } = await import('../api/admin/feedback.js');

const positive = await call(submitFeedback, {
  method: 'POST',
  headers: {},
  body: {
    league_slug: 'bamsbl',
    question: 'What is catchers interference?',
    ai_response: 'The batter is awarded first base.',
    is_positive: true,
    comments: null,
  },
});
console.log('submit positive:', positive.status, positive.body);

const negative = await call(submitFeedback, {
  method: 'POST',
  headers: {},
  body: {
    league_slug: 'BAMSBL',
    question: 'Checked swing interference call?',
    ai_response: 'Wrong matrix routed me here.',
    is_positive: false,
    comments: 'It sent me to runner collision instead of catcher interference.',
  },
});
console.log('submit negative:', negative.status, negative.body);

const admin = await call(adminFeedback, {
  method: 'GET',
  headers: { authorization: `Bearer ${process.env.ADMIN_PASSWORD}` },
  query: { limit: '10' },
});
console.log('admin list:', admin.status, 'count:', admin.body.feedback?.length);

const ok =
  positive.status === 200 && positive.body.ok &&
  negative.status === 200 && negative.body.ok &&
  admin.status === 200 && (admin.body.feedback?.length ?? 0) >= 2;

if (!ok) process.exit(1);
console.log('\n✓ Feedback loop smoke test passed');
