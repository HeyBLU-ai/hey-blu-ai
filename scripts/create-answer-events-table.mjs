/**
 * scripts/create-answer-events-table.mjs
 *
 * Immutable server-side answer tokens for feedback anchoring.
 *
 * Run once:
 *   node scripts/create-answer-events-table.mjs
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  await client.query(`
    CREATE TABLE IF NOT EXISTS answer_events (
      id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      league_slug           TEXT        NOT NULL,
      fallback_league_slug  TEXT,
      question              TEXT        NOT NULL,
      answer                TEXT        NOT NULL,
      state                 TEXT        NOT NULL,
      used_fallback         BOOLEAN     NOT NULL DEFAULT false,
      active_version_id     UUID,
      fallback_version_id   UUID,
      retrieved_source_ids  UUID[]      NOT NULL DEFAULT '{}',
      cited_rule_numbers    TEXT[]      NOT NULL DEFAULT '{}',
      matrix_id             TEXT,
      cached                BOOLEAN     NOT NULL DEFAULT false,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT chk_answer_events_state
        CHECK (state IN ('answered', 'ruling'))
    )
  `);
  console.log('  ✓ answer_events table created (or already exists)');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_answer_events_league_created
    ON answer_events (league_slug, created_at DESC)
  `);
  console.log('  ✓ idx_answer_events_league_created index ensured');

  await client.query(`
    ALTER TABLE user_feedback
    ADD COLUMN IF NOT EXISTS answer_event_id UUID REFERENCES answer_events(id) ON DELETE SET NULL
  `);
  console.log('  ✓ user_feedback.answer_event_id column ensured');

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_user_feedback_answer_event_id
    ON user_feedback (answer_event_id)
    WHERE answer_event_id IS NOT NULL
  `);
  console.log('  ✓ idx_user_feedback_answer_event_id index ensured');

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
