/**
 * scripts/link-nsll-fallback.mjs
 *
 * Set NSLL Minors AAA fallback_league_id to the Little League International row.
 *
 * Usage:
 *   node scripts/link-nsll-fallback.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
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
} catch { /* rely on env */ }

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const NSLL_SLUG = 'nsll-minors-aaa';
const FALLBACK_SLUG = 'little-league';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const client = await pool.connect();

try {
  const { rows: [fallback] } = await client.query(`
    SELECT id, slug, name FROM leagues WHERE slug = $1
  `, [FALLBACK_SLUG]);
  if (!fallback) {
    throw new Error(`League with slug "${FALLBACK_SLUG}" not found. Run ingest-docx first.`);
  }

  const { rows: [before] } = await client.query(`
    SELECT id, slug, name, fallback_league_id FROM leagues WHERE slug = $1
  `, [NSLL_SLUG]);
  if (!before) {
    throw new Error(`League with slug "${NSLL_SLUG}" not found.`);
  }

  console.log(`  Fallback: ${fallback.name} (${fallback.id})`);
  console.log(`  NSLL:     ${before.name} (${before.id})`);
  console.log(`  Before:   fallback_league_id = ${before.fallback_league_id ?? 'null'}`);

  if (before.fallback_league_id === fallback.id) {
    console.log('\n  ✓ Already linked — no update needed.');
  } else {
    await client.query('BEGIN');

    const { rowCount } = await client.query(`
      UPDATE leagues
      SET    fallback_league_id = $1
      WHERE  slug = $2
    `, [fallback.id, NSLL_SLUG]);

    if (rowCount !== 1) {
      throw new Error(`Expected to update 1 ${NSLL_SLUG} row, updated ${rowCount ?? 0}.`);
    }

    await client.query('COMMIT');

    const { rows: [after] } = await client.query(`
      SELECT l.slug, l.fallback_league_id, fb.slug AS fallback_slug, fb.name AS fallback_name
      FROM leagues l
      LEFT JOIN leagues fb ON fb.id = l.fallback_league_id
      WHERE l.slug = $1
    `, [NSLL_SLUG]);

    console.log(`  After:    fallback_league_id = ${after.fallback_league_id}`);
    console.log(`            fallback = ${after.fallback_name} (${after.fallback_slug})`);
    console.log('\n  ✓ NSLL Minors AAA fallback linked to Little League International.');
  }
} catch (err) {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  console.error('  ✗ Link failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
