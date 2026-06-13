/**
 * GET  /api/admin/review?league=<slug>      — list rulebook versions for a league
 * GET  /api/admin/review?version_id=<uuid>  — atoms + quality metrics for a version
 * PATCH /api/admin/review                   — { id, rule_number } — inline-edit an atom
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 */

import pg from 'pg';
const { Client } = pg;

// ── Auth wrapper ──────────────────────────────────────────────────────────────

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return handler(req, res);
};

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // ── GET ── ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { league, version_id } = req.query ?? {};

      // ── GET ?version_id=<uuid> → atoms + metrics ──────────────────────────
      if (version_id) {
        const { rows: atoms } = await client.query(`
          SELECT id, rule_number, title, body, atom_key
          FROM   rules
          WHERE  rulebook_version_id = $1
          ORDER BY
            CASE WHEN rule_number IS NULL OR TRIM(rule_number) = '' THEN 1 ELSE 0 END,
            rule_number NULLS LAST,
            title
          LIMIT 3000
        `, [version_id]);

        const total      = atoms.length;
        const unnumbered = atoms.filter(r => !r.rule_number?.trim()).length;

        // Count rule numbers that appear more than once
        const numFreq = {};
        for (const r of atoms) {
          const rn = r.rule_number?.trim();
          if (rn) numFreq[rn] = (numFreq[rn] ?? 0) + 1;
        }
        const duplicateRuleNumbers = Object.values(numFreq).filter(n => n > 1).length;

        return res.status(200).json({ version_id, total, unnumbered, duplicateRuleNumbers, atoms });
      }

      // ── GET ?league=<slug> → list versions ────────────────────────────────
      if (league) {
        const { rows: versions } = await client.query(`
          SELECT  rv.id,
                  rv.status,
                  rv.created_at,
                  COUNT(r.id)::int AS atom_count
          FROM    rulebook_versions rv
          JOIN    leagues l ON l.id = rv.league_id
          LEFT    JOIN rules r ON r.rulebook_version_id = rv.id
          WHERE   l.slug = $1
          GROUP   BY rv.id, rv.status, rv.created_at
          ORDER   BY rv.created_at DESC
        `, [league]);

        return res.status(200).json({ league, versions });
      }

      return res.status(400).json({ error: 'Provide ?league=<slug> or ?version_id=<uuid>' });
    }

    // ── PATCH → inline-edit rule_number ───────────────────────────────────────
    if (req.method === 'PATCH') {
      const body = req.body ?? {};
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!('rule_number' in body)) return res.status(400).json({ error: 'rule_number required' });

      const rn = typeof body.rule_number === 'string' ? body.rule_number.trim() : null;

      const { rowCount } = await client.query(
        `UPDATE rules SET rule_number = $1 WHERE id = $2`,
        [rn || null, id],
      );

      if (rowCount === 0) return res.status(404).json({ error: 'Atom not found' });

      return res.status(200).json({ ok: true, id, rule_number: rn || null });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[admin/review]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
