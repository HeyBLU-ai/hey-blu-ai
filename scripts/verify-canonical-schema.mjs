/**
 * Verify canonical ingestion tables and cache schema after migration.
 *
 * Usage:
 *   node scripts/verify-canonical-schema.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

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

const REQUIRED_TABLES = [
  'extraction_runs',
  'source_pages',
  'source_blocks',
  'rule_nodes',
  'rule_node_chunks',
  'canonicalization_warnings',
  'verified_answer_cache',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  const tables = await client.query(`
    SELECT table_name
    FROM   information_schema.tables
    WHERE  table_schema = 'public'
      AND  table_name = ANY($1::text[])
    ORDER  BY table_name
  `, [REQUIRED_TABLES]);

  const found = new Set(tables.rows.map(r => r.table_name));
  let ok = true;
  for (const name of REQUIRED_TABLES) {
    if (found.has(name)) {
      console.log(`  ✓ ${name}`);
    } else {
      console.error(`  ✗ ${name} — missing`);
      ok = false;
    }
  }

  const cacheCols = await client.query(`
    SELECT column_name
    FROM   information_schema.columns
    WHERE  table_name = 'verified_answer_cache'
      AND  column_name = 'prompt_version'
  `);
  if (cacheCols.rows.length === 1) {
    console.log('  ✓ verified_answer_cache.prompt_version');
  } else {
    console.error('  ✗ verified_answer_cache.prompt_version — missing');
    ok = false;
  }

  if (!ok) process.exit(1);
  console.log('\nSchema verification passed.');
} finally {
  client.release();
  await pool.end();
}
