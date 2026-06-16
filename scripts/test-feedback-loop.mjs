#!/usr/bin/env node
/**
 * Smoke test: feedback anchored to answer_events (idempotent upsert).
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

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

async function seedAnswerEvent(client, { question, answer, league_slug, cited }) {
  const { rows } = await client.query(
    `INSERT INTO answer_events (
       league_slug, question, answer, state, cited_rule_numbers
     ) VALUES ($1, $2, $3, 'answered', $4::text[])
     RETURNING id`,
    [league_slug, question, answer, cited],
  );
  return rows[0].id;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const client = await pool.connect();

const { default: submitFeedback } = await import('../api/submit-feedback.js');
const { default: adminFeedback } = await import('../api/admin/feedback.js');

try {
  const positiveId = await seedAnswerEvent(client, {
    league_slug: 'bamsbl',
    question: 'What is the courtesy runner rule?',
    answer: 'Rule 430 governs courtesy runners.',
    cited: ['430', '432'],
  });

  const negativeId = await seedAnswerEvent(client, {
    league_slug: 'bamsbl',
    question: 'Checked swing interference call?',
    answer: 'Wrong matrix routed me here.',
    cited: ['505', '432'],
  });

  const missing = await call(submitFeedback, {
    method: 'POST',
    headers: {},
    body: { is_positive: true },
  });

  const positive = await call(submitFeedback, {
    method: 'POST',
    headers: {},
    body: { answer_event_id: positiveId, is_positive: true },
  });

  const positiveDup = await call(submitFeedback, {
    method: 'POST',
    headers: {},
    body: { answer_event_id: positiveId, is_positive: true, comments: 'double tap' },
  });

  const negative = await call(submitFeedback, {
    method: 'POST',
    headers: {},
    body: {
      answer_event_id: negativeId,
      is_positive: false,
      comments: 'It sent me to runner collision instead of catcher interference.',
    },
  });

  const admin = await call(adminFeedback, {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.ADMIN_PASSWORD}` },
    query: { limit: '10' },
  });

  console.log('missing answer_event_id:', missing.status, missing.body);
  console.log('submit positive:', positive.status, positive.body);
  console.log('submit positive dup:', positiveDup.status, positiveDup.body);
  console.log('submit negative:', negative.status, negative.body);
  console.log('admin list:', admin.status, 'count:', admin.body.feedback?.length);

  const latest = admin.body.feedback?.find((f) => f.answer_event_id === negativeId)
    ?? admin.body.feedback?.[0];
  const rulesOk = Array.isArray(latest?.retrieved_rule_codes) && latest.retrieved_rule_codes.includes('505');
  console.log('negative retrieved_rule_codes:', latest?.retrieved_rule_codes);

  const ok =
    missing.status === 400 &&
    positive.status === 200 && positive.body.ok &&
    positiveDup.status === 200 && positiveDup.body.id === positive.body.id &&
    negative.status === 200 && negative.body.ok &&
    admin.status === 200 && (admin.body.feedback?.length ?? 0) >= 2 &&
    rulesOk;

  if (!ok) process.exit(1);
  console.log('\n✓ Feedback loop smoke test passed');
} finally {
  client.release();
  await pool.end();
}
