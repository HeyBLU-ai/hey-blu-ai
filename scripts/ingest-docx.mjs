#!/usr/bin/env node
/**
 * Streamlined DOCX ingestion for structured league rulebooks.
 *
 * DOCX → mammoth HTML → turndown Markdown → heading/paragraph sections
 * → rule_nodes + rule_node_chunks → embeddings → active version.
 *
 * Bypasses PDF coordinate logic, source_blocks, canonicalizer, and TOC heuristics.
 *
 * Usage:
 *   node scripts/ingest-docx.mjs <docx-path> <league-slug> [--season 2025] [--allow-duplicate-hash] [--league-name "Display Name"]
 *
 * Example:
 *   node scripts/ingest-docx.mjs rulebooks/2025-NSLL-Minor-AAA-Local-Rules-1.docx nsll-minors-aaa --season 2025
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import OpenAI from 'openai';
import { runDocxIngest } from '../lib/ingest/docx-pipeline.mjs';

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
const nameFlag = rest.indexOf('--league-name');
const leagueName = nameFlag >= 0 ? rest[nameFlag + 1] : null;

if (!fileArg || !leagueSlug) {
  console.error(
    'Usage: node scripts/ingest-docx.mjs <docx-path> <league-slug> ' +
    '[--season 2025] [--allow-duplicate-hash] [--league-name "Display Name"]',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
  console.error('DATABASE_URL and OPENAI_API_KEY are required.');
  process.exit(1);
}

const docxPath = path.isAbsolute(fileArg) ? fileArg : path.resolve(fileArg);
const docxBuffer = await fs.readFile(docxPath);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

try {
  const result = await runDocxIngest({
    dbClient: client,
    connectionString: process.env.DATABASE_URL,
    leagueSlug,
    leagueName: leagueName ?? undefined,
    season,
    docxBuffer,
    filename: path.basename(docxPath),
    openai,
    allowDuplicateHash,
    onProgress(step, message) {
      console.log(`  [${step}] ${message}`);
    },
  });
  console.log('\n✓ DOCX ingest succeeded');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('\n✗ DOCX ingest failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
