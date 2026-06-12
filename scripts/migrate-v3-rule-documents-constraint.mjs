/**
 * scripts/migrate-v3-rule-documents-constraint.mjs
 *
 * Fixes the rule_documents unique constraint so that the same source file
 * can be ingested into multiple draft versions (e.g. for pipeline re-runs
 * after code changes).
 *
 * Before: UNIQUE (league_id, source_hash)   ← blocks re-ingest of same file
 * After:  UNIQUE (version_id, source_hash)  ← one document per version (correct)
 *
 * Run once:
 *   node scripts/migrate-v3-rule-documents-constraint.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';

const lines = readFileSync('.env.local', 'utf8').split('\n');
for (const l of lines) {
  const t = l.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  // 1. Drop the overly-restrictive (league_id, source_hash) unique constraint
  const dropRes = await client.query(`
    ALTER TABLE rule_documents
      DROP CONSTRAINT IF EXISTS uq_rule_documents_league_hash
  `);
  console.log('  ✓ Dropped constraint uq_rule_documents_league_hash (if existed)');

  // 2. Add the correct (version_id, source_hash) unique constraint
  await client.query(`
    ALTER TABLE rule_documents
      ADD CONSTRAINT uq_rule_documents_version_hash
      UNIQUE (version_id, source_hash)
  `);
  console.log('  ✓ Added constraint uq_rule_documents_version_hash UNIQUE (version_id, source_hash)');

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
