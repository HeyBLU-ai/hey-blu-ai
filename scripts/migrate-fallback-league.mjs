/**
 * scripts/migrate-fallback-league.mjs
 *
 * Adds leagues.fallback_league_id for system-level rulebook fallback during
 * evidence retrieval. Seeds from parent_league_id where unset.
 *
 * Run once:
 *   node scripts/migrate-fallback-league.mjs
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

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  await client.query(`
    ALTER TABLE leagues
      ADD COLUMN IF NOT EXISTS fallback_league_id UUID REFERENCES leagues(id) ON DELETE SET NULL
  `);
  console.log('  ✓ leagues.fallback_league_id column added (or already exists)');

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'leagues_fallback_not_self'
      ) THEN
        ALTER TABLE leagues
          ADD CONSTRAINT leagues_fallback_not_self
          CHECK (fallback_league_id IS NULL OR fallback_league_id != id);
      END IF;
    END $$
  `);
  console.log('  ✓ leagues_fallback_not_self constraint ensured');

  const { rowCount } = await client.query(`
    UPDATE leagues
    SET    fallback_league_id = parent_league_id
    WHERE  fallback_league_id IS NULL
      AND  parent_league_id IS NOT NULL
      AND  parent_league_id != id
  `);
  console.log(`  ✓ Seeded fallback_league_id from parent_league_id (${rowCount ?? 0} row(s))`);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_leagues_fallback_league_id
    ON leagues (fallback_league_id)
    WHERE fallback_league_id IS NOT NULL
  `);
  console.log('  ✓ idx_leagues_fallback_league_id index ensured');

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
