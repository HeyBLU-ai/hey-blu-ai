/**
 * scripts/run-canonicalizer.mjs
 *
 * Execute the Canonicalizer for the latest BAMSBL google-doc-ai extraction
 * and persist rule_nodes + rule_node_chunks.
 *
 * Usage:
 *   node scripts/run-canonicalizer.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Canonicalizer } from '../lib/ingest/canonicalizer.js';

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
  } catch { /* ignore */ }
}

loadLocalEnv();

/**
 * @param {Array<{ node_key: string, node_type: string, rule_number: string|null, title: string|null, parent_key: string|null, body_text: string }>} nodes
 * @param {number} limit
 */
function printRuleTree(nodes, limit = 5) {
  const byKey = new Map(nodes.map(n => [n.node_key, n]));
  const children = new Map();
  for (const n of nodes) {
    const pk = n.parent_key ?? '__root__';
    if (!children.has(pk)) children.set(pk, []);
    children.get(pk).push(n);
  }

  const ruleNodes = nodes.filter(n => n.node_type === 'rule').slice(0, limit);

  console.log('\n── First rule nodes (hierarchy preview) ──\n');

  for (const rule of ruleNodes) {
    const label = rule.rule_number
      ? `Rule ${rule.rule_number}${rule.title ? `: ${rule.title}` : ''}`
      : rule.node_key;
    console.log(`▸ ${label}`);
    console.log(`  type=${rule.node_type}  pages=${rule.page_start ?? '?'}-${rule.page_end ?? '?'}`);
    const preview = (rule.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    console.log(`  body: ${preview || '(heading only)'}${preview.length >= 120 ? '…' : ''}`);

    const subs = (children.get(rule.node_key) ?? []).filter(c => c.node_type === 'subrule');
    for (const sub of subs.slice(0, 3)) {
      const subMeta = sub.metadata ?? {};
      const subLabel = sub.title ? `${subMeta.sub_key ?? '?'}. ${sub.title}` : sub.node_key;
      console.log(`    └─ subrule: ${subLabel}`);
      const subPreview = (sub.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (subPreview) console.log(`       ${subPreview}${subPreview.length >= 80 ? '…' : ''}`);
    }
    if (subs.length > 3) console.log(`    └─ … +${subs.length - 3} more subrules`);
    console.log('');
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  const { rows: runs } = await client.query(`
    SELECT er.id, er.rulebook_version_id, er.page_count, er.block_count
    FROM extraction_runs er
    JOIN rulebook_versions rv ON rv.id = er.rulebook_version_id
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = 'bamsbl'
      AND rv.status = 'active'
      AND er.vendor = 'google-document-ai'
      AND er.status = 'completed'
    ORDER BY er.completed_at DESC NULLS LAST, er.created_at DESC
    LIMIT 1
  `);

  if (runs.length === 0) {
    throw new Error('No completed google-document-ai extraction_run for BAMSBL. Run ingest-vendor-blocks first.');
  }

  const run = runs[0];
  console.log(`Canonicalizing extraction_run ${run.id}`);
  console.log(`  pages=${run.page_count}  blocks=${run.block_count}`);

  await client.query('BEGIN');

  // Clear prior graph for this extraction run (idempotent).
  await client.query(`DELETE FROM rule_nodes WHERE extraction_run_id = $1`, [run.id]);

  const canonicalizer = new Canonicalizer(client, run.id);
  const { nodes, chunks, warnings } = await canonicalizer.run();

  console.log(`\nCanonicalized: ${nodes.length} nodes, ${chunks.length} chunks, ${warnings.length} warnings`);
  if (warnings.length > 0) {
    console.log('Warnings (first 5):');
    for (const w of warnings.slice(0, 5)) console.log(`  • ${w}`);
  }

  const keyToId = new Map();

  for (const node of nodes) {
    const parentId = node.parent_key ? keyToId.get(node.parent_key) ?? null : null;
    const materializedPath = node.parent_key
      ? `${node.parent_key}/${node.node_key}`
      : node.node_key;

    const res = await client.query(`
      INSERT INTO rule_nodes (
        extraction_run_id, rulebook_version_id, parent_id,
        node_type, node_key, rule_number, title, body_text,
        sort_order, depth, materialized_path,
        page_start, page_end, char_start, char_end,
        source_block_ids, metadata
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16::uuid[], $17::jsonb
      )
      RETURNING id
    `, [
      run.id,
      run.rulebook_version_id,
      parentId,
      node.node_type,
      node.node_key,
      node.rule_number,
      node.title,
      node.body_text,
      node.sort_order,
      node.depth,
      materializedPath,
      node.page_start,
      node.page_end,
      node.char_start,
      node.char_end,
      node.source_block_ids,
      JSON.stringify(node.metadata ?? {}),
    ]);

    keyToId.set(node.node_key, res.rows[0].id);
  }

  for (const chunk of chunks) {
    const nodeId = keyToId.get(chunk.node_key);
    if (!nodeId) continue;

    await client.query(`
      INSERT INTO rule_node_chunks (
        rule_node_id, extraction_run_id, chunk_index,
        chunk_text, char_start, char_end, source_block_ids
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[])
    `, [
      nodeId,
      run.id,
      chunk.chunk_index,
      chunk.chunk_text,
      chunk.char_start,
      chunk.char_end,
      chunk.source_block_ids,
    ]);
  }

  await client.query(`
    UPDATE extraction_runs
    SET node_count = $2, warning_count = $3
    WHERE id = $1
  `, [run.id, nodes.length, warnings.length]);

  await client.query('COMMIT');

  const persisted = nodes.map(n => ({
    ...n,
    id: keyToId.get(n.node_key),
  }));

  printRuleTree(persisted, 5);

  console.log(`✓ Wrote ${nodes.length} rule_nodes and ${chunks.length} rule_node_chunks`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Canonicalizer failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
