/**
 * scripts/flush-verified-answer-cache.mjs
 *
 * Deletes all rows from verified_answer_cache.
 * Run after deploying cache guardrails or when stale answers are suspected.
 *
 * Usage:
 *   node scripts/flush-verified-answer-cache.mjs
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  const before = await client.query('SELECT COUNT(*)::int AS n FROM verified_answer_cache');
  await client.query('TRUNCATE verified_answer_cache');
  console.log(`Flushed verified_answer_cache (${before.rows[0].n} rows deleted).`);
} catch (err) {
  console.error('Flush failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
