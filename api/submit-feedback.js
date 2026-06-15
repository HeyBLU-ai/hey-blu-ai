/**
 * POST /api/submit-feedback
 *
 * Persists rulebook answer ratings from the public rulebook UI.
 *
 * Body:
 *   league_slug  {string}   — league slug (required)
 *   question     {string}   — user question (required)
 *   ai_response  {string}   — AI answer text (required)
 *   is_positive           {boolean}  — true = thumbs up, false = thumbs down
 *   comments              {string?}  — optional free-text feedback
 *   retrieved_rule_codes  {string[]} — rule numbers the RAG retrieved (optional)
 */

import pg from 'pg';

const { Client } = pg;

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

function resolveLeagueSlug(league) {
  const value = (league || '').toLowerCase().trim();
  if (value === 'bamsbl') return 'bamsbl';
  if (value === 'little league' || value === 'little league international') return 'little-league';
  if (value === 'mill valley aaa' || value === 'mill valley') return 'mill-valley-aaa';
  if (value === 'usssa' || value === 'usssa baseball') return 'usssa';
  if (value === 'mlb' || value === 'mlb official rules of baseball') return 'mlb';
  return value;
}

function normalizeRuleCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((code) => String(code ?? '').trim())
      .filter(Boolean)
      .slice(0, 20),
  )];
}

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    league_slug: rawLeagueSlug,
    league,
    question: rawQuestion,
    ai_response: rawAiResponse,
    is_positive: rawIsPositive,
    comments: rawComments,
    retrieved_rule_codes: rawRetrievedRuleCodes,
  } = req.body ?? {};

  const leagueSlug = resolveLeagueSlug(rawLeagueSlug || league);
  const question   = sanitizeText(rawQuestion, 1000);
  const aiResponse = sanitizeText(rawAiResponse, 8000);
  const comments   = rawComments == null || rawComments === ''
    ? null
    : sanitizeText(rawComments, 2000);
  const isPositive = rawIsPositive === true;
  const retrievedRuleCodes = normalizeRuleCodes(rawRetrievedRuleCodes);

  if (!leagueSlug) {
    return res.status(400).json({ error: 'league_slug is required' });
  }
  if (question.length < 3) {
    return res.status(400).json({ error: 'question must be at least 3 characters' });
  }
  if (!aiResponse) {
    return res.status(400).json({ error: 'ai_response is required' });
  }
  if (typeof rawIsPositive !== 'boolean') {
    return res.status(400).json({ error: 'is_positive must be a boolean' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'Missing database connection' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const { rows } = await client.query(
      `INSERT INTO user_feedback (
         league_slug, question, ai_response, retrieved_rule_codes, is_positive, comments
       ) VALUES ($1, $2, $3, $4::text[], $5, $6)
       RETURNING id, created_at`,
      [leagueSlug, question, aiResponse, retrievedRuleCodes, isPositive, comments],
    );

    let cacheDeleted = 0;
    if (!isPositive) {
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

    return res.status(200).json({
      ok: true,
      id: rows[0]?.id,
      created_at: rows[0]?.created_at,
      cacheDeleted,
    });
  } catch (err) {
    console.error('[submit-feedback] ERROR:', err.message);
    return res.status(500).json({ error: 'Failed to save feedback' });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withCors(handler);
