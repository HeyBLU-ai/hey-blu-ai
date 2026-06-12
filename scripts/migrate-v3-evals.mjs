/**
 * scripts/migrate-v3-evals.mjs
 *
 * Idempotent migration for the eval_cases table.
 * The table was seeded by an earlier migration run; this script:
 *   - Creates it if it does not yet exist (exact advisor schema)
 *   - Adds any columns that are missing from the canonical schema
 *   - Reports the final column list so the caller can confirm correctness
 *
 * Safe to run multiple times.
 *
 * Usage:
 *   node scripts/migrate-v3-evals.mjs
 */

import pg   from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  // ── 1. Create the table if it does not exist ─────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS eval_cases (
      id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      league_slug          TEXT        NOT NULL,
      question             TEXT        NOT NULL,
      expected_rule_number TEXT,
      expected_state       TEXT        NOT NULL,
      case_type            TEXT        NOT NULL,
      tier                 TEXT        NOT NULL DEFAULT 'broad',
      source               TEXT        NOT NULL DEFAULT 'human',
      last_run_passed      BOOLEAN,
      last_run_at          TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log('  ✓ eval_cases table present');

  // ── 2. Ensure all canonical columns exist (idempotent ALTER TABLE) ─────────
  const requiredColumns = [
    { name: 'expected_rule_number', ddl: 'TEXT' },
    { name: 'expected_state',       ddl: "TEXT NOT NULL DEFAULT 'answered'" },
    { name: 'case_type',            ddl: 'TEXT NOT NULL DEFAULT \'manual\'' },
    { name: 'tier',                 ddl: "TEXT NOT NULL DEFAULT 'broad'" },
    { name: 'source',               ddl: "TEXT NOT NULL DEFAULT 'human'" },
    { name: 'last_run_passed',      ddl: 'BOOLEAN' },
    { name: 'last_run_at',          ddl: 'TIMESTAMPTZ' },
  ];

  const existing = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'eval_cases'
  `);
  const existingNames = new Set(existing.rows.map(r => r.column_name));

  for (const col of requiredColumns) {
    if (!existingNames.has(col.name)) {
      await client.query(`ALTER TABLE eval_cases ADD COLUMN ${col.name} ${col.ddl}`);
      console.log(`  ✓ Added missing column: ${col.name}`);
    }
  }

  // ── 3. Helpful index for eval runner queries ──────────────────────────────
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_cases_league_tier
    ON eval_cases (league_slug, tier)
  `);
  console.log('  ✓ Index idx_eval_cases_league_tier present');

  await client.query('COMMIT');

  // ── 4. Report final schema ────────────────────────────────────────────────
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'eval_cases'
    ORDER BY ordinal_position
  `);
  console.log('\n  Final eval_cases schema:');
  for (const c of cols.rows) {
    console.log(`    ${c.column_name.padEnd(24)} ${c.data_type.padEnd(30)} nullable=${c.is_nullable}`);
  }

  const cnt = await client.query('SELECT COUNT(*) FROM eval_cases');
  console.log(`\n  Existing row count: ${cnt.rows[0].count}`);
  console.log('\n  Migration complete.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('  ✗ Migration failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
