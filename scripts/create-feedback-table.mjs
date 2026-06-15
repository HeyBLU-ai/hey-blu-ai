/**
 * scripts/create-feedback-table.mjs
 *
 * Creates user_feedback table for rulebook thumbs up/down ratings.
 *
 * Run once:
 *   node scripts/create-feedback-table.mjs
 */
import pg from 'pg';
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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      league_slug          TEXT        NOT NULL,
      question             TEXT        NOT NULL,
      ai_response          TEXT        NOT NULL,
      retrieved_rule_codes TEXT[]      NOT NULL DEFAULT '{}',
      is_positive          BOOLEAN     NOT NULL,
      comments             TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log('  ✓ user_feedback table created (or already exists)');

  await client.query(`
    ALTER TABLE user_feedback
    ADD COLUMN IF NOT EXISTS retrieved_rule_codes TEXT[] NOT NULL DEFAULT '{}'
  `);
  console.log('  ✓ retrieved_rule_codes column ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_user_feedback_created_at
    ON user_feedback (created_at DESC)
  `);
  console.log('  ✓ idx_user_feedback_created_at index ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_user_feedback_is_positive
    ON user_feedback (is_positive, created_at DESC)
  `);
  console.log('  ✓ idx_user_feedback_is_positive index ensured');

  await client.query('COMMIT');
  console.log('\n  Migration complete.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('  ✗ Migration failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
