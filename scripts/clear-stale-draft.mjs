/**
 * scripts/clear-stale-draft.mjs
 *
 * Deletes all DRAFT rulebook versions for a given league slug.
 * CASCADE on rule_documents and rule_sources removes those rows too.
 *
 * Usage:
 *   node scripts/clear-stale-draft.mjs [slug]
 *   node scripts/clear-stale-draft.mjs bamsbl
 *
 * Defaults to 'bamsbl' if no slug argument is provided.
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
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const slug = process.argv[2] ?? 'bamsbl';

console.log(`\n━━━  Clear stale DRAFT versions  ━━━\n`);
console.log(`  League slug : ${slug}`);

try {
  // Show what we are about to delete
  const preview = await pool.query(`
    SELECT rv.id, rv.season, rv.status, rv.created_at,
           (SELECT COUNT(*) FROM rule_documents rd WHERE rd.version_id = rv.id) AS docs,
           (SELECT COUNT(*) FROM rule_sources   rs WHERE rs.document_id IN
             (SELECT id FROM rule_documents WHERE version_id = rv.id))           AS sources
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = $1 AND rv.status = 'draft'
  `, [slug]);

  if (preview.rows.length === 0) {
    console.log(`  No DRAFT versions found for "${slug}" — nothing to delete.\n`);
    process.exit(0);
  }

  console.log(`\n  Versions to delete:`);
  for (const r of preview.rows) {
    console.log(`    [${r.status}] id=${r.id}  season=${r.season}  created=${r.created_at.toISOString().slice(0, 19)}  docs=${r.docs}  sources=${r.sources}`);
  }

  // Execute delete (CASCADE removes rule_documents → rule_sources)
  const del = await pool.query(`
    DELETE FROM rulebook_versions
    WHERE league_id = (SELECT id FROM leagues WHERE slug = $1)
      AND status = 'draft'
  `, [slug]);

  console.log(`\n  ✓ Deleted ${del.rowCount} rulebook_version row(s) (CASCADE removed rule_documents + rule_sources).\n`);

  // Verify
  const remaining = await pool.query(`
    SELECT COUNT(*) AS n FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = $1 AND rv.status = 'draft'
  `, [slug]);
  console.log(`  Remaining DRAFT rows for "${slug}": ${remaining.rows[0].n}\n`);

} finally {
  await pool.end();
}
