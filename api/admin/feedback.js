/**
 * GET /api/admin/feedback
 *
 * Returns recent user_feedback rows for the QA admin dashboard.
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 */

import pg from 'pg';

const { Client } = pg;

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return handler(req, res);
};

const handler = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const limit = Math.min(Math.max(parseInt(req.query?.limit ?? '50', 10) || 50, 1), 200);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT id, league_slug, question, ai_response, retrieved_rule_codes,
              is_positive, comments, created_at
       FROM user_feedback
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.status(200).json({ feedback: rows });
  } catch (err) {
    console.error('[admin/feedback]', err.message);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
