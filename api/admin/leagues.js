/**
 * GET /api/admin/leagues
 *
 * Returns all leagues from the DB ordered by name, with rule counts.
 * Used to populate the league dropdown in the admin dashboard.
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

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        l.id,
        l.slug,
        l.name,
        l.is_foundation,
        p.name  AS parent_name,
        p.slug  AS parent_slug,
        COUNT(r.id)::int AS rule_count
      FROM  leagues l
      LEFT JOIN leagues p ON p.id = l.parent_league_id
      LEFT JOIN rules   r ON r.league_id = l.id
      GROUP BY l.id, l.slug, l.name, l.is_foundation, p.name, p.slug
      ORDER BY l.name
    `);
    return res.status(200).json({ leagues: rows });
  } catch (err) {
    console.error('[admin/leagues]', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
