#!/usr/bin/env node
/**
 * Verify ingestion integrity gates:
 *   1. Scan active league version for zero-chunk nodes
 *   2. Prove activation rejects versions with invisible rules
 *
 * Usage:
 *   node scripts/test-integrity-gates.mjs --league=bamsbl
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { activateCanonicalVersion } from '../lib/ingest/canonical-pipeline.mjs';
import {
  assertNoZeroChunkNodes,
  findZeroChunkNodes,
} from '../lib/ingest/integrity-gates.mjs';

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

function parseLeague(argv) {
  for (const arg of argv) {
    if (arg.startsWith('--league=')) return arg.slice('--league='.length).trim().toLowerCase();
  }
  return 'bamsbl';
}

function ok(label) {
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  process.exit(1);
}

/**
 * Create a disposable draft in the current transaction with one invisible rule.
 */
async function createSyntheticDraft(client, leagueId, extractionRunId) {
  const draftRes = await client.query(`
    INSERT INTO rulebook_versions (league_id, season, status, source_hash)
    VALUES ($1, $2, 'draft', 'integrity-gate-test')
    RETURNING id
  `, [leagueId, String(new Date().getFullYear())]);
  const versionId = draftRes.rows[0].id;

  const runRes = await client.query(`
    INSERT INTO extraction_runs (
      rulebook_version_id, vendor, vendor_adapter, pipeline_version,
      status, input_mime_type, page_count, block_count, started_at, completed_at
    ) VALUES ($1, 'test', 'test', 'integrity-test', 'completed', 'application/pdf', 1, 1, now(), now())
    RETURNING id
  `, [versionId]);
  const runId = runRes.rows[0].id;

  const goodNode = await client.query(`
    INSERT INTO rule_nodes (
      extraction_run_id, rulebook_version_id, node_type, node_key,
      rule_number, title, body_text, sort_order, depth, materialized_path,
      source_block_ids, metadata
    ) VALUES ($1, $2, 'rule', 'rule:9998', '9998', 'Visible Rule', 'Has chunks.', 1, 0, 'rule:9998', '{}'::uuid[], '{}'::jsonb)
    RETURNING id
  `, [runId, versionId]);

  const badNode = await client.query(`
    INSERT INTO rule_nodes (
      extraction_run_id, rulebook_version_id, node_type, node_key,
      rule_number, title, body_text, sort_order, depth, materialized_path,
      source_block_ids, metadata
    ) VALUES ($1, $2, 'rule', 'rule:9999', '9999', 'Invisible Rule', 'No chunks for retrieval.', 2, 0, 'rule:9999', '{}'::uuid[], '{}'::jsonb)
    RETURNING id
  `, [runId, versionId]);

  await client.query(`
    INSERT INTO rule_node_chunks (
      rule_node_id, extraction_run_id, chunk_index, chunk_text, source_block_ids, embedding
    ) VALUES ($1, $2, 0, 'Has chunks.', '{}'::uuid[], $3::vector)
  `, [
    goodNode.rows[0].id,
    runId,
    `[${Array(1536).fill(0).join(',')}]`,
  ]);

  return {
    versionId,
    runId,
    offenderId: badNode.rows[0].id,
  };
}

async function main() {
  await loadEnv();
  const league = parseLeague(process.argv.slice(2));
  if (!process.env.DATABASE_URL) fail('DATABASE_URL required');

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    console.log(`Integrity gate test — league=${league}`);

    const { rows: [leagueRow] } = await client.query(`SELECT id FROM leagues WHERE slug = $1`, [league]);
    if (!leagueRow) fail(`league not found: ${league}`);

    const { rows: [version] } = await client.query(`
      SELECT rv.id
      FROM rulebook_versions rv
      WHERE rv.league_id = $1 AND rv.status = 'active'
      LIMIT 1
    `, [leagueRow.id]);
    if (!version) fail(`no active version for ${league}`);

    const missing = await findZeroChunkNodes(client, version.id);
    if (missing.length === 0) {
      ok(`active version has no zero-chunk nodes (${version.id})`);
    } else {
      fail(`active version has ${missing.length} zero-chunk node(s)`, missing.map((n) => n.rule_number ?? n.node_key).join(', '));
    }

    await assertNoZeroChunkNodes(client, version.id);
    ok('assertNoZeroChunkNodes passes on clean active version');

    await client.query('BEGIN');

    const synthetic = await createSyntheticDraft(client, leagueRow.id);
    const blocked = await findZeroChunkNodes(client, synthetic.versionId);
    if (!blocked.some((n) => n.id === synthetic.offenderId)) {
      await client.query('ROLLBACK');
      fail('synthetic invisible rule not detected');
    }
    ok('synthetic zero-chunk node detected (Rule 9999)');

    let threw = false;
    try {
      await assertNoZeroChunkNodes(client, synthetic.versionId);
    } catch (err) {
      threw = true;
      if (!String(err.message).includes('Cannot activate')) {
        await client.query('ROLLBACK');
        fail('assertNoZeroChunkNodes wrong error', err.message);
      }
      ok('assertNoZeroChunkNodes blocks synthetic draft');
    }
    if (!threw) {
      await client.query('ROLLBACK');
      fail('assertNoZeroChunkNodes did not throw');
    }

    try {
      await activateCanonicalVersion(client, synthetic.versionId);
      await client.query('ROLLBACK');
      fail('activateCanonicalVersion should have thrown');
    } catch (err) {
      if (!String(err.message).includes('zero search chunks')) {
        await client.query('ROLLBACK');
        fail('activateCanonicalVersion wrong error', err.message);
      }
      ok('activateCanonicalVersion rejects draft with invisible rules');
    }

    await client.query('ROLLBACK');
    ok('transaction rolled back — no persistent test data');

    console.log('\nAll integrity gate checks passed.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail('unexpected error', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
