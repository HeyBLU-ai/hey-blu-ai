/**
 * Execute a SQL migration file against DATABASE_URL.
 *
 * Usage:
 *   node scripts/run-sql-migration.mjs docs/VERIFIED_ANSWER_CACHE_MIGRATION.sql
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  try {
    for (const line of readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] ??= v;
    }
  } catch {
    // CI / Vercel may inject env directly.
  }
}

loadLocalEnv();

const sqlPath = process.argv[2];
if (!sqlPath) {
  console.error('Usage: node scripts/run-sql-migration.mjs <path-to.sql>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = readFileSync(resolve(process.cwd(), sqlPath), 'utf8');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  console.log(`Running migration: ${sqlPath}`);
  await client.query(sql);
  console.log('  ✓ Migration complete.');
} catch (err) {
  console.error('  ✗ Migration failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
