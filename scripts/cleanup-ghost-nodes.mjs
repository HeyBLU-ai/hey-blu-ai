/**
 * scripts/cleanup-ghost-nodes.mjs
 *
 * Delete obsolete child rule_nodes under a parent (default: rule:430 / Rule 430).
 *
 * Usage:
 *   node scripts/cleanup-ghost-nodes.mjs
 *   node scripts/cleanup-ghost-nodes.mjs 430
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { deleteDescendantNodes } from '../api/admin/rule-nodes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  try {
    for (const line of readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] ??= v;
    }
  } catch { /* */ }
}

loadLocalEnv();

const nodeKeyInput = process.argv[2] ?? '430';
const leagueSlug   = process.env.LEAGUE_SLUG ?? 'bamsbl';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  const { rows: parents } = await client.query(`
    SELECT rn.id, rn.node_key, rn.rule_number, rn.title, rn.materialized_path, rn.node_type
    FROM   rule_nodes rn
    JOIN   rulebook_versions rv ON rv.id = rn.rulebook_version_id
    JOIN   leagues l ON l.id = rv.league_id
    WHERE  l.slug = $1::text
      AND  rv.status = 'active'
      AND  (
        rn.node_key IN ('rule:' || $2::text, $2::text)
        OR (rn.rule_number = $2::text AND rn.node_type = 'rule')
      )
    ORDER BY CASE rn.node_type WHEN 'rule' THEN 0 ELSE 1 END
    LIMIT 1
  `, [leagueSlug, nodeKeyInput]);

  if (!parents.length) {
    throw new Error(`No active parent rule node found for "${nodeKeyInput}" in ${leagueSlug}`);
  }

  const parent = parents[0];

  const { rows: childrenBefore } = await client.query(`
    SELECT id, node_key, node_type, rule_number, materialized_path, left(body_text, 80) AS body_preview
    FROM   rule_nodes
    WHERE  parent_id = $1::uuid
       OR  (
         id != $1::uuid
         AND (
           materialized_path LIKE $2::text
           OR materialized_path LIKE $3::text
         )
       )
    ORDER BY node_key
  `, [
    parent.id,
    parent.materialized_path ? `${parent.materialized_path}/%` : `${parent.node_key}/%`,
    `${parent.node_key}/%`,
  ]);

  console.log(`Parent: ${parent.node_key} (${parent.title ?? 'untitled'})`);
  console.log(`  id:   ${parent.id}`);
  console.log(`  path: ${parent.materialized_path ?? '(none)'}`);
  console.log(`\nChildren to delete (${childrenBefore.length}):`);
  for (const c of childrenBefore) {
    console.log(`  • ${c.node_key} [${c.node_type}] ${c.body_preview ? `— ${JSON.stringify(c.body_preview)}` : ''}`);
  }

  if (childrenBefore.length === 0) {
    console.log('\nNo ghost child nodes found.');
    process.exit(0);
  }

  await client.query('BEGIN');
  const deleted = await deleteDescendantNodes(client, parent.id);
  await client.query('COMMIT');

  console.log(`\n✓ Deleted ${deleted} descendant node(s) under ${parent.node_key}`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Cleanup failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
