/**
 * Runs docs/RULEBOOK_DB_MIGRATION.sql against the Supabase database.
 * Uses DATABASE_URL from .env.local — no psql required.
 *
 * Usage: node api/run-migration.mjs
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const __dirname  = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ──────────────────────────────────────────────────────────

try {
  const raw = await readFile(resolve(__dirname, '../.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq  = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.error('✗  Could not load .env.local');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('✗  DATABASE_URL not set in .env.local');
  process.exit(1);
}

// ── Load the SQL file ────────────────────────────────────────────────────────

const sqlPath = resolve(__dirname, '../docs/RULEBOOK_DB_MIGRATION.sql');
let sql;
try {
  sql = await readFile(sqlPath, 'utf-8');
  console.log(`✓  Loaded migration SQL (${(sql.length / 1024).toFixed(1)} KB)`);
} catch {
  console.error(`✗  Could not read ${sqlPath}`);
  process.exit(1);
}

// ── Connect and run ──────────────────────────────────────────────────────────

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },  // required for Supabase
});

console.log('\n  Connecting to database…');

try {
  await client.connect();
  console.log('✓  Connected\n');
  console.log('  Running migration…\n');

  await client.query(sql);

  console.log('✓  Migration complete.\n');

  // ── Verify key tables exist ──────────────────────────────────────────────

  const { rows: tables } = await client.query(`
    SELECT table_name
    FROM   information_schema.tables
    WHERE  table_schema = 'public'
      AND  table_name   IN ('leagues','rules','rule_embeddings','question_logs')
    ORDER  BY table_name;
  `);

  console.log('  Tables confirmed:');
  for (const { table_name } of tables) {
    console.log(`    ✓  ${table_name}`);
  }

  // ── Row counts ───────────────────────────────────────────────────────────

  const { rows: leagueCounts } = await client.query(`
    SELECT l.name, COUNT(r.id) AS rule_count
    FROM   leagues l
    LEFT   JOIN rules r ON r.league_id = l.id
    GROUP  BY l.name
    ORDER  BY l.name;
  `);

  if (leagueCounts.length > 0) {
    console.log('\n  Seeded data:');
    for (const { name, rule_count } of leagueCounts) {
      console.log(`    ${name}: ${rule_count} rules`);
    }
  }

  console.log('\n  ✓  Database is ready.\n');

} catch (err) {
  console.error('\n  ✗  Migration failed:', err.message);
  if (err.message.includes('already exists')) {
    console.error('\n  If tables already exist and you want to re-run, add DROP TABLE');
    console.error('  statements to the SQL or connect to Supabase dashboard and');
    console.error('  drop the tables manually first.\n');
  }
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
