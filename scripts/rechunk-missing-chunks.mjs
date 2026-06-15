#!/usr/bin/env node
/**
 * Scan active/draft rulebook versions for rule_nodes with body_text but zero
 * chunks, auto-repair via rechunk + embed, and resolve ZERO_CHUNKS warnings.
 *
 * Usage:
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl --status=draft
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl --rule=430
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl --scan-only
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import OpenAI from 'openai';
import { embedChunksForVersion } from '../lib/ingest/canonical-pipeline.mjs';
import {
  findZeroChunkNodes,
  resolveZeroChunkWarnings,
  ZERO_CHUNKS_WARNING_CODE,
} from '../lib/ingest/integrity-gates.mjs';
import { rechunkNodes } from '../lib/ingest/rechunk-nodes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
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
}

function parseArgs(argv) {
  let league = null;
  let rule = null;
  let status = 'all';
  let scanOnly = false;

  for (const arg of argv) {
    if (arg.startsWith('--league=')) league = arg.slice('--league='.length).trim().toLowerCase();
    if (arg.startsWith('--rule=')) rule = arg.slice('--rule='.length).trim();
    if (arg.startsWith('--status=')) status = arg.slice('--status='.length).trim().toLowerCase();
    if (arg === '--scan-only' || arg === '--verify-only' || arg === '--dry-run') scanOnly = true;
  }

  return { league, rule, status, scanOnly };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} leagueSlug
 * @param {'active'|'draft'|'all'} status
 */
async function resolveVersions(client, leagueSlug, status) {
  const statuses = status === 'all' ? ['active', 'draft'] : [status];
  const { rows } = await client.query(`
    SELECT rv.id, rv.status,
           (SELECT er.id FROM extraction_runs er
             WHERE er.rulebook_version_id = rv.id
             ORDER BY er.completed_at DESC NULLS LAST
             LIMIT 1) AS extraction_run_id
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = $1
      AND rv.status = ANY($2::text[])
    ORDER BY CASE rv.status WHEN 'active' THEN 0 ELSE 1 END, rv.updated_at DESC
  `, [leagueSlug, statuses]);

  return rows.filter((r) => r.extraction_run_id);
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} versionId
 * @param {string|null} rule
 */
async function loadMissingNodes(client, versionId, rule) {
  const nodes = await findZeroChunkNodes(client, versionId);
  if (!rule) return nodes;
  return nodes.filter((n) => n.rule_number === rule || n.node_key === rule || n.node_key === `rule:${rule}`);
}

async function repairVersion(client, openai, version, missing, scanOnly) {
  const label = `${version.status} version ${version.id}`;
  if (!missing.length) {
    console.log(`[rechunk] ✓ ${label}: no zero-chunk nodes`);
    return { repaired: 0, chunks: 0, embedded: 0, warningsResolved: 0 };
  }

  console.log(`[rechunk] ${label}: ${missing.length} zero-chunk node(s):`);
  for (const n of missing) {
    console.log(`  • ${ZERO_CHUNKS_WARNING_CODE}: ${n.rule_number ?? n.node_key} — ${n.title ?? '(no title)'} (${n.body_len} chars)`);
  }

  if (scanOnly) {
    return { repaired: missing.length, chunks: 0, embedded: 0, warningsResolved: 0, scanOnly: true };
  }

  const nodeIds = missing.map((n) => n.id);
  const chunkTotal = await rechunkNodes(client, nodeIds, version.extraction_run_id);
  console.log(`[rechunk]   created ${chunkTotal} chunk(s)`);

  const embed = await embedChunksForVersion(client, version.id, openai, (done, total) => {
    if (done === total || (total > 0 && done % 32 === 0)) {
      console.log(`[rechunk]   embedded ${done}/${total}`);
    }
  });
  console.log(`[rechunk]   embedded ${embed.embedded} new chunk(s)`);

  const warningsResolved = await resolveZeroChunkWarnings(client, version.id, nodeIds);
  console.log(`[rechunk]   resolved ${warningsResolved} ZERO_CHUNKS warning(s)`);

  return {
    repaired: missing.length,
    chunks: chunkTotal,
    embedded: embed.embedded,
    warningsResolved,
  };
}

async function main() {
  await loadEnv();
  const { league, rule, status, scanOnly } = parseArgs(process.argv.slice(2));

  if (!league) {
    console.error('Usage: node scripts/rechunk-missing-chunks.mjs --league=<slug> [--status=active|draft|all] [--rule=430] [--scan-only]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required.');
    process.exit(1);
  }
  if (!scanOnly && !process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY required (omit --scan-only to repair).');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  const openai = scanOnly ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const versions = await resolveVersions(client, league, status);
    if (!versions.length) {
      throw new Error(`No ${status === 'all' ? 'active or draft' : status} version found for league "${league}".`);
    }

    console.log(`[rechunk] league=${league} status=${status}${scanOnly ? ' (scan only)' : ''}`);

    let totalMissing = 0;
    const summary = [];

    if (!scanOnly) await client.query('BEGIN');

    for (const version of versions) {
      const missing = await loadMissingNodes(client, version.id, rule);
      totalMissing += missing.length;
      const result = await repairVersion(client, openai, version, missing, scanOnly);
      summary.push({ version, ...result });
    }

    if (!scanOnly) await client.query('COMMIT');

    if (totalMissing === 0) {
      console.log(`\n[rechunk] OK — no invisible rules (body_text with zero chunks).`);
      process.exit(0);
    }

    if (scanOnly) {
      console.log(`\n[rechunk] FAIL — ${totalMissing} invisible rule node(s) found. Run without --scan-only to repair.`);
      process.exit(1);
    }

    console.log('\n[rechunk] Repair complete.');
    for (const s of summary) {
      if (s.repaired > 0) {
        console.log(`  ${s.version.status}: repaired ${s.repaired}, chunks=${s.chunks}, embedded=${s.embedded}, warnings=${s.warningsResolved}`);
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[rechunk] failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
