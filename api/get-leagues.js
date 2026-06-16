/**
 * GET /api/get-leagues
 *
 * Public endpoint: leagues with an active rulebook version, for the rulebook UI.
 */

import pg from 'pg';

const { Client } = pg;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT DISTINCT l.slug, l.name
      FROM   leagues l
      JOIN   rulebook_versions rv
             ON rv.league_id = l.id AND rv.status = 'active'
      ORDER  BY l.name ASC
    `);
    return res.status(200).json({ leagues: rows });
  } catch (err) {
    console.error('[get-leagues]', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}
