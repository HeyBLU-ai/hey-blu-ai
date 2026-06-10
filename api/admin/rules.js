/**
 * GET /api/admin/rules?league=<slug>&search=<query>
 *
 * Returns all rules for a league (with optional keyword search).
 * Used by the admin rule browser to spot-check ingestion quality.
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
  const { league, search = '' } = req.query ?? {};
  if (!league) return res.status(400).json({ error: 'league slug required' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL not configured' });

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();

    // League info
    const { rows: leagueRows } = await client.query(
      `SELECT id, name, slug FROM leagues WHERE slug=$1`, [league],
    );
    if (!leagueRows.length) return res.status(404).json({ error: `League "${league}" not found` });
    const { id: leagueId, name: leagueName } = leagueRows[0];

    // Rules query — with embedding status and optional search
    const searchPat = search ? `%${search.toLowerCase()}%` : null;
    const { rows } = await client.query(`
      SELECT
        r.id,
        r.rule_number,
        r.title,
        r.body,
        r.sport,
        r.is_override,
        r.confidence,
        r.created_at,
        (re.id IS NOT NULL) AS has_embedding
      FROM  rules r
      LEFT  JOIN rule_embeddings re ON re.rule_id = r.id AND re.model = 'text-embedding-3-small'
      WHERE r.league_id = $1
        AND ($2::text IS NULL
             OR LOWER(r.rule_number) LIKE $2
             OR LOWER(r.title)       LIKE $2
             OR LOWER(r.body)        LIKE $2)
      ORDER BY r.rule_number, r.sport
      LIMIT 500
    `, [leagueId, searchPat]);

    return res.status(200).json({
      league:     leagueName,
      leagueSlug: league,
      total:      rows.length,
      rules:      rows,
    });
  } catch (err) {
    console.error('[admin/rules]', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
