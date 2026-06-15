/**
 * GET  /api/admin/rule-nodes?node_key=430&league=bamsbl  — fetch rule_node + canonical text
 * PUT  /api/admin/rule-nodes                           — { node_key, league?, canonical_text }
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
import { rechunkNodes } from '../../lib/ingest/rechunk-nodes.mjs';

const { Client } = pg;

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return handler(req, res);
};

async function ensureCanonicalTextColumn(client) {
  await client.query(`
    ALTER TABLE rule_nodes ADD COLUMN IF NOT EXISTS canonical_text TEXT
  `);
}

/**
 * @param {string} input — rule number ("430") or full node_key ("rule:430")
 * @returns {string[]}
 */
function nodeKeyCandidates(input) {
  const key = String(input ?? '').trim();
  if (!key) return [];
  const candidates = new Set([key]);
  if (!key.includes(':')) {
    candidates.add(`rule:${key}`);
    candidates.add(`subrule:${key}`);
    candidates.add(`chapter:${key}`);
  }
  return [...candidates];
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
 */
async function buildNodeResponse(client, ruleNodeId) {
  const { rows: [node] } = await client.query(`
    SELECT id, node_key, node_type, rule_number, title, body_text,
           materialized_path, canonical_text, rulebook_version_id
    FROM   rule_nodes
    WHERE  id = $1::uuid
  `, [ruleNodeId]);

  if (!node) return null;

  const ancestors = await fetchAncestorChain(client, ruleNodeId);
  const ancestorPath = formatAncestorPath(ancestors.slice(0, -1));
  const children = await fetchChildAnnotations(client, ruleNodeId);
  const computed = buildCanonicalText(node, ancestorPath, children);

  return {
    id:                  node.id,
    node_key:              node.node_key,
    node_type:             node.node_type,
    rule_number:           node.rule_number,
    title:                 node.title,
    rule_path:             ancestorPath || node.materialized_path || null,
    canonical_text:        (node.canonical_text ?? '').trim() || computed,
    body_text:             node.body_text,
    rulebook_version_id:   node.rulebook_version_id,
    has_canonical_override: Boolean((node.canonical_text ?? '').trim()),
    child_count:           children.length,
  };
}

/**
 * @param {import('pg').Client} client
 * @param {string} leagueSlug
 * @param {string} nodeKeyInput
 */
async function findRuleNode(client, leagueSlug, nodeKeyInput) {
  const keys = nodeKeyCandidates(nodeKeyInput);
  if (!keys.length) return null;

  const { rows } = await client.query(`
    SELECT rn.id
    FROM   rule_nodes rn
    JOIN   rulebook_versions rv ON rv.id = rn.rulebook_version_id
    JOIN   leagues l ON l.id = rv.league_id
    WHERE  l.slug = $1::text
      AND  rv.status = 'active'
      AND  (
        rn.node_key = ANY($2::text[])
        OR rn.rule_number = $3::text
      )
    ORDER BY
      CASE rn.node_type
        WHEN 'rule' THEN 0
        WHEN 'chapter' THEN 1
        WHEN 'subrule' THEN 2
        ELSE 3
      END,
      rn.sort_order ASC
    LIMIT 1
  `, [leagueSlug, keys, String(nodeKeyInput).trim()]);

  return rows[0]?.id ?? null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} ruleNodeId
 * @returns {Promise<number>}
 */
export async function deleteDescendantNodes(client, ruleNodeId) {
  const { rows: [parent] } = await client.query(`
    SELECT id, node_key, materialized_path
    FROM   rule_nodes
    WHERE  id = $1::uuid
  `, [ruleNodeId]);

  if (!parent) return 0;

  const pathPrefix = parent.materialized_path
    ? `${parent.materialized_path}/%`
    : null;
  const keyPrefix = `${parent.node_key}/%`;

  const { rowCount } = await client.query(`
    WITH RECURSIVE descendants AS (
      SELECT id
      FROM   rule_nodes
      WHERE  parent_id = $1::uuid
      UNION ALL
      SELECT rn.id
      FROM   rule_nodes rn
      JOIN   descendants d ON rn.parent_id = d.id
    ),
    to_delete AS (
      SELECT id FROM descendants
      UNION
      SELECT rn.id
      FROM   rule_nodes rn
      WHERE  rn.id != $1::uuid
        AND  (
          rn.materialized_path LIKE $2::text
          OR rn.materialized_path LIKE $3::text
        )
    )
    DELETE FROM rule_nodes
    WHERE id IN (SELECT id FROM to_delete)
  `, [ruleNodeId, pathPrefix ?? keyPrefix, keyPrefix]);

  return rowCount ?? 0;
}

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

    if (req.method === 'GET') {
      const { node_key, league = 'bamsbl' } = req.query ?? {};
      if (!node_key) {
        return res.status(400).json({ error: 'node_key query parameter required' });
      }

      const ruleNodeId = await findRuleNode(client, league, node_key);
      if (!ruleNodeId) {
        return res.status(404).json({ error: `No active rule node found for "${node_key}" in ${league}` });
      }

      const node = await buildNodeResponse(client, ruleNodeId);
      return res.status(200).json({ league, node });
    }

    if (req.method === 'PUT') {
      const body = req.body ?? {};
      const { node_key, league = 'bamsbl', canonical_text } = body;

      if (!node_key) return res.status(400).json({ error: 'node_key required' });
      if (typeof canonical_text !== 'string' || !canonical_text.trim()) {
        return res.status(400).json({ error: 'canonical_text required' });
      }

      const ruleNodeId = await findRuleNode(client, league, node_key);
      if (!ruleNodeId) {
        return res.status(404).json({ error: `No active rule node found for "${node_key}" in ${league}` });
      }

      const { rows: [node] } = await client.query(`
        SELECT id, title, rule_number, extraction_run_id
        FROM   rule_nodes
        WHERE  id = $1::uuid
      `, [ruleNodeId]);

      const trimmedText = canonical_text.trim();
      const bodyText = extractBodyFromCanonical(trimmedText, node);

      await client.query('BEGIN');

      await client.query(`
        UPDATE rule_nodes
        SET    canonical_text = $1::text,
               body_text      = $2::text,
               updated_at     = now()
        WHERE  id = $3::uuid
      `, [trimmedText, bodyText, ruleNodeId]);

      if (bodyText.trim() && node.extraction_run_id) {
        await rechunkNodes(client, [ruleNodeId], node.extraction_run_id);
      }

      const deletedChildren = await deleteDescendantNodes(client, ruleNodeId);

      await client.query('COMMIT');

      const updated = await buildNodeResponse(client, ruleNodeId);
      return res.status(200).json({ ok: true, league, node: updated, deleted_children: deletedChildren });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[admin/rule-nodes]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  } finally {
    try { await client.end(); } catch {}
  }
};

export default withAdminAuth(handler);
