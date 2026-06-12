/**
 * scripts/check-db-counts.mjs
 *
 * Quick sanity check: prints row counts for every V3 ingest table.
 * Run after a live ingest to confirm data landed correctly.
 *
 * Usage:
 *   node scripts/check-db-counts.mjs
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env.local (Vercel convention) — dotenv/config only reads .env
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env.local not found — rely on process env */ }

const { Pool } = pg;

const TABLES = [
  'leagues',
  'rulebook_versions',
  'rule_documents',
  'rule_sources',
  'rules',
  'rule_source_links',
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

console.log('\n━━━  V3 Database Row Counts  ━━━\n');

try {
  for (const table of TABLES) {
    const res = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const n = res.rows[0].n;
    console.log(`  ${table.padEnd(22)} : ${n}`);
  }

  // Also show per-league breakdown for rules
  const leagueRules = await pool.query(`
    SELECT l.slug, COUNT(r.id) AS rules
    FROM rules r
    JOIN leagues l ON l.id = r.league_id
    GROUP BY l.slug
    ORDER BY l.slug
  `);
  if (leagueRules.rows.length > 0) {
    console.log('\n  Rules by league:');
    for (const row of leagueRules.rows) {
      console.log(`    ${row.slug.padEnd(20)} : ${row.rules}`);
    }
  }

  // Show draft versions
  const versions = await pool.query(`
    SELECT rv.id, l.slug, rv.season, rv.status, rv.created_at
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    ORDER BY rv.created_at DESC
    LIMIT 5
  `);
  if (versions.rows.length > 0) {
    console.log('\n  Latest rulebook_versions:');
    for (const v of versions.rows) {
      console.log(`    [${v.status.padEnd(7)}] ${v.slug} ${v.season}  id=${v.id}`);
    }
  }

  console.log('\n  ✓ All counts retrieved successfully.\n');
} finally {
  await pool.end();
}
