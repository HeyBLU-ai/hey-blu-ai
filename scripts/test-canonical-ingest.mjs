/**
 * Smoke test: run canonical PDF ingest for a league (CLI).
 *
 * Usage:
 *   node scripts/test-canonical-ingest.mjs rulebooks/2026-MLB-rules-only.pdf mlb --season 2026
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import OpenAI from 'openai';
import { runCanonicalIngestFromPdf } from '../lib/ingest/canonical-pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const line of (await fs.readFile(path.join(__dirname, '../.env.local'), 'utf8')).split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const [fileArg, leagueSlug, ...rest] = process.argv.slice(2);
const seasonFlag = rest.indexOf('--season');
const season = seasonFlag >= 0 ? rest[seasonFlag + 1] : String(new Date().getFullYear());
const allowDuplicateHash = rest.includes('--allow-duplicate-hash');

if (!fileArg || !leagueSlug) {
  console.error('Usage: node scripts/test-canonical-ingest.mjs <pdf-path> <league-slug> [--season 2026] [--allow-duplicate-hash]');
  process.exit(1);
}

const pdfPath = path.isAbsolute(fileArg) ? fileArg : path.resolve(fileArg);
const pdfBuffer = await fs.readFile(pdfPath);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

try {
  await client.query('BEGIN');
  const result = await runCanonicalIngestFromPdf({
    dbClient: client,
    leagueSlug,
    season,
    pdfBuffer,
    filename: path.basename(pdfPath),
    openai,
    allowDuplicateHash,
    onProgress(step, message) {
      console.log(`  [${step}] ${message}`);
    },
  });
  await client.query('COMMIT');
  console.log('\n✓ Canonical ingest succeeded');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n✗ Canonical ingest failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
