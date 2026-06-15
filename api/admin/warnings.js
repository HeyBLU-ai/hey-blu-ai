/**
 * GET  /api/admin/warnings  — unresolved canonicalization warnings + rule context
 * POST /api/admin/warnings  — { warning_id, updated_text } save fix + resolve
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 */

import pg from 'pg';
import {
  buildCanonicalText,
  fetchAncestorChain,
  fetchChildAnnotations,
  formatAncestorPath,
} from '../../lib/ingest/evidence-bundle.js';

const { Client } = pg;

// ── Auth wrapper ──────────────────────────────────────────────────────────────

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return handler(req, res);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ensure canonical_text column exists for QA overrides (idempotent).
 *
 * @param {import('pg').Client} client
 */
async function ensureCanonicalTextColumn(client) {
  await client.query(`
    ALTER TABLE rule_nodes ADD COLUMN IF NOT EXISTS canonical_text TEXT
  `);
}

/**
 * @param {string} updatedText
 * @param {{ title: string|null, rule_number: string|null }} node
 * @returns {string}
 */
function extractBodyFromCanonical(updatedText, node) {
  const lines = (updatedText ?? '').split('\n');
  const bodyLines = [];
  let pastHeader = false;

  for (const line of lines) {
    if (!pastHeader) {
      if (line.startsWith('Path:')) continue;
      if (/^Rule \d+:/.test(line)) { pastHeader = true; continue; }
      if (node.title && line.trim() === node.title.trim()) { pastHeader = true; continue; }
      if (!line.trim()) continue;
      pastHeader = true;
      bodyLines.push(line);
      continue;
    }
    if (/^(Comment|Exception|Penalty):/i.test(line.trim())) break;
    bodyLines.push(line);
  }

  return bodyLines.join('\n').trim();
}

/**
 * @param {import('pg').Client} client
 * @param {string} ruleNodeId
 * @returns {Promise<{ rule_path: string, canonical_text: string }|null>}
 */
async function buildNodeContext(client, ruleNodeId) {
  const { rows: [node] } = await client.query(`
    SELECT id, node_type, rule_number, title, body_text, materialized_path, canonical_text
    FROM   rule_nodes
    WHERE  id = $1
  `, [ruleNodeId]);

  if (!node) return null;

  const ancestors = await fetchAncestorChain(client, ruleNodeId);
  const ancestorPath = formatAncestorPath(ancestors.slice(0, -1));
  const children = await fetchChildAnnotations(client, ruleNodeId);
  const computed = buildCanonicalText(node, ancestorPath, children);

  const rule_path = ancestorPath || node.materialized_path || node.rule_number || node.id;
  const canonical_text = (node.canonical_text ?? '').trim() || computed;

  return { rule_path, canonical_text };
}

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
    await ensureCanonicalTextColumn(client);

    // ── GET: unresolved warnings ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const { rows } = await client.query(`
        SELECT
          w.id,
          w.extraction_run_id,
          w.rulebook_version_id,
          w.rule_node_id,
          w.warning_code,
          w.severity,
          w.message,
          w.details,
          w.is_blocking,
          w.created_at,
          rn.rule_number,
          rn.title       AS node_title,
          rn.materialized_path
        FROM canonicalization_warnings w
        LEFT JOIN rule_nodes rn ON rn.id = w.rule_node_id
        JOIN rulebook_versions rv ON rv.id = w.rulebook_version_id
        WHERE w.resolved_at IS NULL
          AND rv.status IN ('active', 'draft')
        ORDER BY w.is_blocking DESC, w.created_at ASC
      `);

      const warnings = [];
      for (const row of rows) {
        let rule_path = row.materialized_path ?? null;
        let canonical_text = null;

        if (row.rule_node_id) {
          const ctx = await buildNodeContext(client, row.rule_node_id);
          if (ctx) {
            rule_path = ctx.rule_path;
            canonical_text = ctx.canonical_text;
          }
        }

        warnings.push({
          id:                  row.id,
          extraction_run_id:   row.extraction_run_id,
          rulebook_version_id: row.rulebook_version_id,
          rule_node_id:        row.rule_node_id,
          warning_code:        row.warning_code,
          severity:            row.severity,
          message:             row.message,
          details:             row.details,
          is_blocking:         row.is_blocking,
          created_at:          row.created_at,
          rule_number:         row.rule_number,
          node_title:          row.node_title,
          rule_path,
          canonical_text:      canonical_text ?? '',
        });
      }

      return res.status(200).json({ warnings, total: warnings.length });
    }

    // ── POST: save canonical text + resolve ──────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const { warning_id, updated_text } = body;

      if (!warning_id) return res.status(400).json({ error: 'warning_id required' });
      if (typeof updated_text !== 'string' || !updated_text.trim()) {
        return res.status(400).json({ error: 'updated_text required' });
      }

      const { rows: [warning] } = await client.query(`
        SELECT id, rule_node_id
        FROM   canonicalization_warnings
        WHERE  id = $1 AND resolved_at IS NULL
      `, [warning_id]);

      if (!warning) {
        return res.status(404).json({ error: 'Warning not found or already resolved' });
      }
      if (!warning.rule_node_id) {
        return res.status(400).json({ error: 'Warning has no linked rule_node_id' });
      }

      const { rows: [node] } = await client.query(`
        SELECT id, title, rule_number
        FROM   rule_nodes
        WHERE  id = $1
      `, [warning.rule_node_id]);

      if (!node) return res.status(404).json({ error: 'Linked rule_node not found' });

      const trimmedText = updated_text.trim();
      const bodyText = extractBodyFromCanonical(trimmedText, node);

      await client.query('BEGIN');

      await client.query(`
        UPDATE rule_nodes
        SET    canonical_text = $1,
               body_text      = $2,
               updated_at     = now()
        WHERE  id = $3
      `, [trimmedText, bodyText, warning.rule_node_id]);

      await client.query(`
        UPDATE rule_node_chunks
        SET    chunk_text = $1
        WHERE  rule_node_id = $2 AND chunk_index = 0
      `, [bodyText || trimmedText, warning.rule_node_id]);

      const { rowCount } = await client.query(`
        UPDATE canonicalization_warnings
        SET    resolved_at = now(),
               resolved_by = 'admin'
        WHERE  id = $1
      `, [warning_id]);

      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Warning not found' });
      }

      await client.query('COMMIT');

      return res.status(200).json({
        ok:           true,
        warning_id,
        rule_node_id: warning.rule_node_id,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[admin/warnings]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
