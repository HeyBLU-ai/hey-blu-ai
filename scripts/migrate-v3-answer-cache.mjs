/**
 * scripts/migrate-v3-answer-cache.mjs
 *
 * Creates the verified_answer_cache table for the advisor's Verified Answer
 * Cache milestone.  Safe to run multiple times (IF NOT EXISTS guard).
 *
 * Run once:
 *   node scripts/migrate-v3-answer-cache.mjs
 *
 * Design notes:
 *   - UNIQUE (league_slug, rulebook_version_id, prompt_version, normalized_question)
 *     scopes cache to active rulebook version and answer prompt version.
 *   - ON DELETE CASCADE on rulebook_version_id means retiring/deleting a version
 *     cleans up its cache rows automatically.
 *   - Only answers that passed the verifier (verifier_status = 'approved') should
 *     ever be written here.
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS verified_answer_cache (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      league_slug         TEXT        NOT NULL,
      rulebook_version_id UUID        NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
      prompt_version      TEXT        NOT NULL DEFAULT '2026-06-13',
      normalized_question TEXT        NOT NULL,
      answer              TEXT        NOT NULL,
      cited_source_ids    UUID[]      NOT NULL,
      cited_rule_numbers  TEXT[],
      verifier_status     TEXT        NOT NULL,
      draft_model         TEXT,
      verify_model        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at        TIMESTAMPTZ,
      hit_count           INT         NOT NULL DEFAULT 0,
      UNIQUE (league_slug, rulebook_version_id, prompt_version, normalized_question)
    )
  `);
  console.log('  ✓ verified_answer_cache table created (or already exists)');

  // Index on the unique columns (PG creates one for UNIQUE, but an explicit one
  // helps with partial lookups by league_slug alone).
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vac_version_slug
    ON verified_answer_cache (rulebook_version_id, league_slug)
  `);
  console.log('  ✓ Index idx_vac_version_slug created (or already exists)');

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
