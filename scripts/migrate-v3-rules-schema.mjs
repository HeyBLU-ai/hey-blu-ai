/**
 * scripts/migrate-v3-rules-schema.mjs
 *
 * One-time migration that isolates rule rows per rulebook version so that
 * re-ingesting the same league never squashes existing atoms.
 *
 * Changes:
 *   1. Add   rules.rulebook_version_id  UUID FK → rulebook_versions(id) CASCADE
 *   2. Drop  the old UNIQUE (league_id, rule_number, sport) constraint
 *   3. Add   new UNIQUE (rulebook_version_id, rule_number, sport) constraint
 *
 * Safe to run multiple times — every step uses IF NOT EXISTS / IF EXISTS guards.
 *
 * Usage:
 *   node scripts/migrate-v3-rules-schema.mjs
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ── Load .env.local ───────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env.local');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runStep(client, label, sql) {
  process.stdout.write(`  ${label} … `);
  try {
    await client.query(sql);
    console.log('✓');
  } catch (err) {
    console.log(`✗  ${err.message}`);
    throw err;
  }
}

async function fetchConstraints(client) {
  const res = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'rules'::regclass
      AND contype = 'u'
  `);
  return res.rows.map(r => r.conname);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\n━━━  V3 Rules Schema Migration  ━━━\n');

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // ── Step 1: Add rulebook_version_id column (idempotent) ───────────────────
  await runStep(
    client,
    'Add rules.rulebook_version_id column',
    `ALTER TABLE rules
       ADD COLUMN IF NOT EXISTS rulebook_version_id UUID
       REFERENCES rulebook_versions(id) ON DELETE CASCADE`,
  );

  // ── Step 2: Drop old UNIQUE constraint(s) on (league_id, rule_number, sport)
  //   The constraint name can vary by how the DB was originally created.
  //   We query pg_constraint to find it exactly rather than hardcoding.
  const existing = await fetchConstraints(client);
  console.log(`\n  Existing UNIQUE constraints on rules: ${existing.join(', ') || '(none)'}`);

  const oldConstraints = existing.filter(n =>
    // Matches the default Postgres-generated name or any variant we may have used
    n.includes('league_id') || n === 'rules_league_id_rule_number_sport_key',
  );

  if (oldConstraints.length === 0) {
    console.log('  No old (league_id, rule_number, sport) constraint found — skipping drop.');
  } else {
    for (const name of oldConstraints) {
      await runStep(
        client,
        `Drop old constraint "${name}"`,
        `ALTER TABLE rules DROP CONSTRAINT IF EXISTS "${name}"`,
      );
    }
  }

  // ── Step 3: Add new UNIQUE constraint scoped to version ───────────────────
  //   ON CONFLICT DO NOTHING if it already exists (Postgres 12+ supports IF NOT EXISTS
  //   for constraints via a workaround using pg_constraint check).
  const afterDrop = await fetchConstraints(client);
  const newConstraintName = 'uq_rules_version_number_sport';
  if (afterDrop.includes(newConstraintName)) {
    console.log(`  Constraint "${newConstraintName}" already exists — skipping add.`);
  } else {
    await runStep(
      client,
      `Add new constraint "${newConstraintName}"`,
      `ALTER TABLE rules
         ADD CONSTRAINT uq_rules_version_number_sport
         UNIQUE (rulebook_version_id, rule_number, sport)`,
    );
  }

  await client.query('COMMIT');

  // ── Summary ───────────────────────────────────────────────────────────────
  const final = await fetchConstraints(client);
  console.log(`\n  Final UNIQUE constraints on rules: ${final.join(', ')}`);

  // Verify column exists
  const colCheck = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name = 'rulebook_version_id'
  `);
  if (colCheck.rows.length > 0) {
    const col = colCheck.rows[0];
    console.log(`  rules.rulebook_version_id : ${col.data_type}, nullable=${col.is_nullable}`);
  }

  console.log('\n  ✓ Migration complete.\n');
} catch (err) {
  await client.query('ROLLBACK');
  console.error(`\n  ✗ Migration ROLLED BACK: ${err.message}\n`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
