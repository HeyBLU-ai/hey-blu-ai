#!/usr/bin/env node
/**
 * scripts/test-search-ranking.mjs
 *
 * Diagnose vector/FTS chunk ranking for a BAMSBL query.
 *
 * Usage:
 *   node scripts/test-search-ranking.mjs
 *   node scripts/test-search-ranking.mjs "courtesy runner rule"
 */
import pg from 'pg';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  buildOrFallbackQuery,
  fetchEvidenceBundles,
  vectorLiteral,
} from '../lib/ingest/evidence-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUESTION = process.argv[2] ?? 'courtesy runner rule';
const LEAGUE_SLUG = 'bamsbl';
const TOP_N = 10;

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
  } catch { /* rely on env */ }
}

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function embedQuestion(question) {
  if (!process.env.OPENAI_API_KEY) return null;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const result = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: question,
      dimensions: 1536,
    });
    const embedding = result.data[0]?.embedding;
    return embedding?.length === 1536 ? vectorLiteral(embedding) : null;
  } catch (err) {
    console.warn('Embedding failed:', err.message);
    return null;
  }
}

function snippet(text, max = 160) {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

async function resolveBamsblVersion(client) {
  const { rows: [row] } = await client.query(`
    SELECT l.id AS league_id,
           l.name AS league_name,
           rv.id AS version_id,
           rv.status,
           rv.created_at
    FROM leagues l
    JOIN rulebook_versions rv ON rv.league_id = l.id AND rv.status = 'active'
    WHERE l.slug = $1
  `, [LEAGUE_SLUG]);
  return row ?? null;
}

async function resolveExtractionRun(client, versionId) {
  const { rows: [run] } = await client.query(`
    SELECT id, status, completed_at, created_at
    FROM extraction_runs
    WHERE rulebook_version_id = $1
      AND status = 'completed'
    ORDER BY completed_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `, [versionId]);
  return run ?? null;
}

async function inspectRule430(client, versionId) {
  const byNumber = await client.query(`
    SELECT id, rule_number, title, node_type,
           length(body_text) AS body_len,
           left(body_text, 200) AS body_preview,
           page_start, page_end
    FROM rule_nodes
    WHERE rulebook_version_id = $1::uuid
      AND rule_number = '430'
    ORDER BY title
  `, [versionId]);

  const byTitle = await client.query(`
    SELECT id, rule_number, title, node_type,
           length(body_text) AS body_len,
           left(body_text, 200) AS body_preview
    FROM rule_nodes
    WHERE rulebook_version_id = $1::uuid
      AND (
        title ILIKE '%Courtesy Runner%'
        OR body_text ILIKE '%Courtesy Runner%'
      )
    ORDER BY rule_number NULLS LAST, title
  `, [versionId]);

  const chunks430 = await client.query(`
    SELECT c.id AS chunk_id, c.chunk_index,
           left(c.chunk_text, 200) AS chunk_preview,
           c.embedding IS NOT NULL AS has_embedding,
           length(c.chunk_text) AS chunk_len
    FROM rule_node_chunks c
    JOIN rule_nodes n ON n.id = c.rule_node_id
    WHERE n.rulebook_version_id = $1::uuid
      AND n.rule_number = '430'
    ORDER BY c.chunk_index
  `, [versionId]);

  return { byNumber: byNumber.rows, byTitle: byTitle.rows, chunks430: chunks430.rows };
}

function printChunkHits(label, hits, orTerms) {
  console.log(`\n${label}`);
  console.log(`OR tsquery terms: ${orTerms || '(none)'}`);
  console.log('─'.repeat(72));
  if (!hits.length) {
    console.log('  (no hits)');
    return;
  }
  hits.forEach((hit, i) => {
    const ruleCode = hit.rule_number ?? hit.node_type ?? '—';
    const score = Number(hit.hybrid_score ?? 0).toFixed(4);
    const vec = Number(hit.vector_score ?? 0).toFixed(4);
    const fts = Number(hit.strict_fts_score ?? 0).toFixed(4);
    const body = snippet(hit.chunk_text || hit.body_text);
    console.log(`${String(i + 1).padStart(2)}. rule_code=${ruleCode}  score=${score}  vector=${vec}  fts=${fts}`);
    console.log(`    title: ${hit.title ?? '(none)'}`);
    console.log(`    chunk_index: ${hit.chunk_index ?? '—'}  chunk_id: ${hit.chunk_id}`);
    console.log(`    body: ${body}`);
  });
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('BAMSBL search ranking diagnostic');
    console.log(`Query: "${QUESTION}"`);

    const league = await resolveBamsblVersion(client);
    if (!league) {
      console.error('No active BAMSBL rulebook version found.');
      process.exit(1);
    }
    console.log(`\nLeague: ${league.league_name} (${LEAGUE_SLUG})`);
    console.log(`Active version: ${league.version_id}`);

    const run = await resolveExtractionRun(client, league.version_id);
    if (!run) {
      console.error('No completed extraction run for active BAMSBL version.');
      process.exit(1);
    }
    console.log(`Extraction run: ${run.id}`);

    const embedding = await embedQuestion(QUESTION);
    console.log(`Embedding: ${embedding ? 'yes (1536-dim)' : 'no — FTS fallback only'}`);

    const production = await fetchEvidenceBundles(client, league.version_id, QUESTION, {
      queryEmbedding: embedding,
      limit: 3,
    });

    const allChunkHits = (production.chunkHits ?? [])
      .slice()
      .sort((a, b) => Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0))
      .slice(0, TOP_N);
    printChunkHits(
      `Top ${TOP_N} chunk hits (${production.method}, pre-dedupe)`,
      allChunkHits,
      buildOrFallbackQuery(QUESTION),
    );

    console.log(`\nProduction bundles (limit=3, post-dedupe) — method: ${production.method}`);
    console.log('─'.repeat(72));
    production.bundles.forEach((b, i) => {
      console.log(`${i + 1}. rule_code=${b.rule_number ?? '—'}  score=${Number(b.hybrid_score).toFixed(4)}`);
      console.log(`   title: ${b.title ?? '(none)'}`);
      console.log(`   body: ${snippet(b.matched_chunk_text || b.canonical_text)}`);
    });

    const rule430 = await inspectRule430(client, league.version_id);
    console.log('\nRule 430 / Courtesy Runners existence check');
    console.log('─'.repeat(72));
    console.log(`Nodes with rule_number = '430': ${rule430.byNumber.length}`);
    for (const n of rule430.byNumber) {
      console.log(`  • ${n.rule_number} — ${n.title} (${n.node_type}, body_len=${n.body_len})`);
      console.log(`    preview: ${snippet(n.body_preview, 120)}`);
    }
    console.log(`\nNodes matching "Courtesy Runner" in title/body: ${rule430.byTitle.length}`);
    for (const n of rule430.byTitle) {
      console.log(`  • rule_code=${n.rule_number ?? '—'} — ${n.title}`);
    }
    console.log(`\nChunks for rule_number '430': ${rule430.chunks430.length}`);
    for (const c of rule430.chunks430) {
      console.log(`  • chunk_index=${c.chunk_index}  has_embedding=${c.has_embedding}  len=${c.chunk_len}`);
      console.log(`    preview: ${snippet(c.chunk_preview, 120)}`);
    }

    const rank430 = allChunkHits.findIndex(h => h.rule_number === '430');
    if (rank430 >= 0) {
      console.log(`\nRule 430 appears at chunk rank #${rank430 + 1} in top-${TOP_N} (score=${Number(allChunkHits[rank430].hybrid_score).toFixed(4)})`);
    } else {
      console.log(`\nRule 430 is NOT in the top-${TOP_N} chunk hits for this query.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
