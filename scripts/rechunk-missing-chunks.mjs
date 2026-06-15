#!/usr/bin/env node
/**
 * Find rule_nodes with body_text but zero chunks, re-chunk, and embed.
 *
 * Usage:
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl
 *   node scripts/rechunk-missing-chunks.mjs --league=bamsbl --rule=430
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import OpenAI from 'openai';
import { rechunkNodes } from '../lib/ingest/rechunk-nodes.mjs';
import { embedChunksForVersion } from '../lib/ingest/canonical-pipeline.mjs';

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
  for (const arg of argv) {
    if (arg.startsWith('--league=')) league = arg.slice('--league='.length).trim().toLowerCase();
    if (arg.startsWith('--rule=')) rule = arg.slice('--rule='.length).trim();
  }
  return { league, rule };
}

async function resolveVersion(client, leagueSlug) {
  const { rows } = await client.query(`
    SELECT rv.id,
           (SELECT er.id FROM extraction_runs er
             WHERE er.rulebook_version_id = rv.id
             ORDER BY er.completed_at DESC NULLS LAST
             LIMIT 1) AS extraction_run_id
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = $1 AND rv.status = 'active'
    LIMIT 1
  `, [leagueSlug]);

  if (!rows.length) throw new Error(`No active version for league "${leagueSlug}"`);
  if (!rows[0].extraction_run_id) throw new Error('Active version has no extraction run');
  return rows[0];
}

async function main() {
  await loadEnv();
  const { league, rule } = parseArgs(process.argv.slice(2));
  if (!league) {
    console.error('Usage: node scripts/rechunk-missing-chunks.mjs --league=<slug> [--rule=430]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
    console.error('DATABASE_URL and OPENAI_API_KEY required.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const version = await resolveVersion(client, league);
    const params = [version.id];
    let ruleFilter = '';
    if (rule) {
      ruleFilter = `AND n.rule_number = $2`;
      params.push(rule);
    }

    const { rows: missing } = await client.query(`
      SELECT n.id, n.rule_number, n.node_key, n.title, length(n.body_text) AS body_len
      FROM rule_nodes n
      WHERE n.rulebook_version_id = $1
        ${ruleFilter}
        AND length(trim(coalesce(n.body_text, ''))) > 0
        AND NOT EXISTS (
          SELECT 1 FROM rule_node_chunks c WHERE c.rule_node_id = n.id
        )
      ORDER BY n.rule_number NULLS LAST, n.node_key
    `, params);

    if (!missing.length) {
      console.log(`[rechunk] No nodes with body_text but zero chunks (${league}).`);
      return;
    }

    console.log(`[rechunk] ${missing.length} node(s) to repair:`);
    for (const n of missing) {
      console.log(`  • ${n.rule_number ?? n.node_key}: ${n.title ?? '(no title)'} (${n.body_len} chars)`);
    }

    await client.query('BEGIN');
    const nodeIds = missing.map(n => n.id);
    const chunkTotal = await rechunkNodes(client, nodeIds, version.extraction_run_id);
    console.log(`[rechunk] Created ${chunkTotal} chunk(s)`);

    const embed = await embedChunksForVersion(client, version.id, openai, (done, total) => {
      if (done === total || done % 32 === 0) {
        console.log(`[rechunk] embedded ${done}/${total}`);
      }
    });
    console.log(`[rechunk] Embedded ${embed.embedded} new chunk(s)`);
    await client.query('COMMIT');
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
