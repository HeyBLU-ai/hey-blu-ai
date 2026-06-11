#!/usr/bin/env node
/**
 * Runs RULEBOOK_DB_MIGRATION_V3.sql against the configured DATABASE_URL.
 * Safe to run multiple times (idempotent CREATE TABLE IF NOT EXISTS).
 */
import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env.local
const envRaw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8');
for (const line of envRaw.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const key = t.slice(0, eq).trim();
  const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = val;
}

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const sqlFull = await fs.readFile(path.join(ROOT, 'docs', 'RULEBOOK_DB_MIGRATION_V3.sql'), 'utf-8');
// Split off the verification queries section — run those separately
const [ddl, verificationSection] = sqlFull.split('-- VERIFICATION QUERIES');

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

console.log('\n━━━  HeyBLU V3 Migration  ━━━\n');

// Run DDL
try {
  await db.query(ddl);
  console.log('✓ DDL executed successfully');
} catch (err) {
  console.error('✗ Migration failed:', err.message);
  await db.end();
  process.exit(1);
}

// Verify tables exist
const tableCheck = await db.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'rulebook_versions','rule_documents','rule_sources',
      'rule_source_links','eval_cases','feedback_items'
    )
  ORDER BY table_name
`);
console.log('\n✓ Tables present:');
tableCheck.rows.forEach(r => console.log('  •', r.table_name));

const missing = 6 - tableCheck.rows.length;
if (missing > 0) {
  console.error(`\n✗ ${missing} table(s) missing — check migration SQL`);
  await db.end();
  process.exit(1);
}

// Row counts
const counts = await db.query(`
  SELECT 'rulebook_versions' AS tbl, COUNT(*)::int AS n FROM rulebook_versions
  UNION ALL SELECT 'rule_documents',    COUNT(*)::int FROM rule_documents
  UNION ALL SELECT 'rule_sources',      COUNT(*)::int FROM rule_sources
  UNION ALL SELECT 'rule_source_links', COUNT(*)::int FROM rule_source_links
  UNION ALL SELECT 'eval_cases',        COUNT(*)::int FROM eval_cases
  UNION ALL SELECT 'feedback_items',    COUNT(*)::int FROM feedback_items
`);
console.log('\n✓ Row counts (all 0 on fresh migration):');
counts.rows.forEach(r => console.log(`  ${r.tbl.padEnd(22)} ${r.n}`));

await db.end();
console.log('\n━━━  Migration complete  ━━━\n');
