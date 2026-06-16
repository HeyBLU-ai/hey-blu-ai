/**
 * scripts/link-bamsbl-mlb.mjs
 *
 * Set BAMSBL's fallback_league_id to the MLB league row.
 *
 * Usage:
 *   node scripts/link-bamsbl-mlb.mjs
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  const { rows: [mlb] } = await client.query(`
    SELECT id, slug, name FROM leagues WHERE slug = 'mlb'
  `);
  if (!mlb) {
    throw new Error('League with slug "mlb" not found.');
  }

  const { rows: [before] } = await client.query(`
    SELECT id, slug, name, fallback_league_id FROM leagues WHERE slug = 'bamsbl'
  `);
  if (!before) {
    throw new Error('League with slug "bamsbl" not found.');
  }

  console.log(`  MLB:    ${mlb.name} (${mlb.id})`);
  console.log(`  BAMSBL: ${before.name} (${before.id})`);
  console.log(`  Before: fallback_league_id = ${before.fallback_league_id ?? 'null'}`);

  if (before.fallback_league_id === mlb.id) {
    console.log('\n  ✓ Already linked — no update needed.');
  } else {
    await client.query('BEGIN');

    const { rowCount } = await client.query(`
      UPDATE leagues
      SET    fallback_league_id = $1
      WHERE  slug = 'bamsbl'
    `, [mlb.id]);

    if (rowCount !== 1) {
      throw new Error(`Expected to update 1 BAMSBL row, updated ${rowCount ?? 0}.`);
    }

    await client.query('COMMIT');

    const { rows: [after] } = await client.query(`
      SELECT l.slug, l.fallback_league_id, fb.slug AS fallback_slug, fb.name AS fallback_name
      FROM leagues l
      LEFT JOIN leagues fb ON fb.id = l.fallback_league_id
      WHERE l.slug = 'bamsbl'
    `);

    console.log(`  After:  fallback_league_id = ${after.fallback_league_id}`);
    console.log(`          fallback = ${after.fallback_name} (${after.fallback_slug})`);
    console.log('\n  ✓ BAMSBL fallback linked to MLB.');
  }
} catch (err) {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  console.error('  ✗ Link failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
