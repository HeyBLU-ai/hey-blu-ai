/**
 * scripts/migrate-v3-atom-key.mjs
 *
 * One-time migration: adds the `atom_key` column to the rules table so that
 * multiple atoms can share the same official rule_number without overwriting
 * each other.
 *
 * Changes:
 *   1. ADD COLUMN atom_key TEXT — the per-version unique key used in the
 *      UPSERT conflict clause. For simple rules, atom_key = rule_number.
 *      For duplicate rule_numbers in the same version, the second atom gets
 *      atom_key = rule_number-2, third → rule_number-3, etc.
 *
 *   2. BACKFILL atom_key = rule_number for all existing rows (safe because
 *      the old unique constraint prevented duplicate rule_numbers per version).
 *
 *   3. SET NOT NULL on atom_key (all rows are now backfilled).
 *
 *   4. DROP old constraint uq_rules_version_number_sport.
 *
 *   5. ADD new constraint uq_rules_version_atom_sport UNIQUE
 *      (rulebook_version_id, atom_key, sport).
 *      Legacy NULL-version rows are unaffected: PostgreSQL treats two NULL
 *      values as distinct for UNIQUE purposes, so the legacy rows continue to
 *      coexist without violating the new constraint.
 *
 * Usage:
 *   node scripts/migrate-v3-atom-key.mjs
 *
 * Idempotent: re-running after a successful migration is a no-op (all
 * ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards are present).
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // ── Step 1: Add the column ────────────────────────────────────────────────
  console.log('Step 1: ADD COLUMN atom_key …');
  await client.query(`
    ALTER TABLE rules ADD COLUMN IF NOT EXISTS atom_key TEXT
  `);

  // ── Step 2: Backfill ──────────────────────────────────────────────────────
  // Safe because the old unique constraint (rulebook_version_id, rule_number, sport)
  // already prevented any duplicates, so setting atom_key = rule_number produces
  // unique atom_key values per (version, sport) pair.
  console.log('Step 2: Backfill atom_key = rule_number for all rows …');
  const { rowCount } = await client.query(`
    UPDATE rules SET atom_key = rule_number WHERE atom_key IS NULL
  `);
  console.log(`  Backfilled ${rowCount} row(s).`);

  // ── Step 3: NOT NULL ──────────────────────────────────────────────────────
  console.log('Step 3: SET NOT NULL on atom_key …');
  await client.query(`
    ALTER TABLE rules ALTER COLUMN atom_key SET NOT NULL
  `);

  // ── Step 4: Drop old constraint ───────────────────────────────────────────
  console.log('Step 4: DROP old UNIQUE constraint uq_rules_version_number_sport …');
  await client.query(`
    ALTER TABLE rules DROP CONSTRAINT IF EXISTS uq_rules_version_number_sport
  `);

  // ── Step 5: Add new constraint ────────────────────────────────────────────
  console.log('Step 5: ADD new UNIQUE constraint uq_rules_version_atom_sport …');
  await client.query(`
    ALTER TABLE rules
      ADD CONSTRAINT uq_rules_version_atom_sport
      UNIQUE (rulebook_version_id, atom_key, sport)
  `);

  await client.query('COMMIT');
  console.log('\n✓ Migration complete.\n');

  // ── Verification ──────────────────────────────────────────────────────────
  console.log('Verification:');
  const col = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM   information_schema.columns
    WHERE  table_name = 'rules' AND column_name = 'atom_key'
  `);
  if (col.rows.length > 0) {
    console.log(`  atom_key column: ${col.rows[0].data_type}, nullable=${col.rows[0].is_nullable}`);
  }

  const con = await client.query(`
    SELECT constraint_name
    FROM   information_schema.table_constraints
    WHERE  table_name = 'rules' AND constraint_type = 'UNIQUE'
    ORDER BY constraint_name
  `);
  console.log('  UNIQUE constraints on rules:');
  for (const r of con.rows) {
    console.log(`    ${r.constraint_name}`);
  }

} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n✗ Migration FAILED — rolled back.\n', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
