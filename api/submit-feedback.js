/**
 * POST /api/submit-feedback
 *
 * Persists rulebook answer ratings anchored to a server-issued answer_event_id.
 * Question, answer text, league, and rule codes are sourced from answer_events —
 * never trusted from the client payload.
 *
 * Body:
 *   answer_event_id  {string}   — UUID from /api/ask-v2 (required)
 *   is_positive      {boolean}  — true = thumbs up, false = thumbs down (required)
 *   comments         {string?} — optional free-text feedback (sanitized)
 */

import pg from 'pg';

const { Client } = pg;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const withCors = (handler) => async (req, res) => {
  const origin = req.headers.origin || '';
  if (
    origin === 'https://heyblu.ai' ||
    origin === 'https://www.heyblu.ai' ||
    origin.endsWith('.vercel.app') ||
    origin.startsWith('http://localhost')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return handler(req, res);
};

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function normalizeQuestion(q) {
  if (!q || typeof q !== 'string') return '';
  return q
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:'"()[\]{}/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    is_positive: rawIsPositive,
    comments: rawComments,
    answer_event_id: rawAnswerEventId,
  } = req.body ?? {};

  const answerEventId = typeof rawAnswerEventId === 'string'
    ? sanitizeText(rawAnswerEventId, 36)
    : '';

  if (!answerEventId) {
    return res.status(400).json({ error: 'answer_event_id is required' });
  }
  if (!UUID_RE.test(answerEventId)) {
    return res.status(400).json({ error: 'answer_event_id must be a valid UUID' });
  }
  if (typeof rawIsPositive !== 'boolean') {
    return res.status(400).json({ error: 'is_positive must be a boolean' });
  }

  const isPositive = rawIsPositive === true;
  const comments = rawComments == null || rawComments === ''
    ? null
    : sanitizeText(rawComments, 2000);

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'Missing database connection' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query('BEGIN');

    const { rows, rowCount } = await client.query(
      `INSERT INTO user_feedback (
         league_slug, question, ai_response, retrieved_rule_codes,
         is_positive, comments, answer_event_id
       )
       SELECT
         ae.league_slug,
         ae.question,
         ae.answer,
         ae.cited_rule_numbers,
         $2::boolean,
         $3::text,
         ae.id
       FROM answer_events ae
       WHERE ae.id = $1::uuid
       ON CONFLICT (answer_event_id) WHERE answer_event_id IS NOT NULL DO UPDATE SET
         is_positive = EXCLUDED.is_positive,
         comments    = EXCLUDED.comments
       RETURNING id, created_at, league_slug, question`,
      [answerEventId, isPositive, comments],
    );

    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'answer_event_id not found' });
    }

    let cacheDeleted = 0;
    if (!isPositive) {
      const { league_slug: leagueSlug, question } = rows[0];
      const normalizedQuestion = normalizeQuestion(question);
      const deleted = await client.query(`
        DELETE FROM verified_answer_cache vac
        USING rulebook_versions rv, leagues l
        WHERE vac.rulebook_version_id = rv.id
          AND rv.league_id = l.id
          AND rv.status = 'active'
          AND vac.league_slug = $1
          AND l.slug = $1
          AND vac.normalized_question = $2
      `, [leagueSlug, normalizedQuestion]);
      cacheDeleted = deleted.rowCount;
    }

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      id: rows[0]?.id,
      answer_event_id: answerEventId,
      created_at: rows[0]?.created_at,
      cacheDeleted,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[submit-feedback] ERROR:', err.message);
    return res.status(500).json({ error: 'Failed to save feedback' });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withCors(handler);
