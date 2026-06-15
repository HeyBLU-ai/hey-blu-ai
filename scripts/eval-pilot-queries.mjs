#!/usr/bin/env node
/**
 * Baseline retrieval accuracy eval for BAMSBL pilot queries.
 * Uses the same dual-path hybrid search as ask-v2 (primary rulebook only).
 *
 * Usage:
 *   node scripts/eval-pilot-queries.mjs
 */
import pg from 'pg';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  fetchEvidenceBundles,
  vectorLiteral,
  bestEvidenceScore,
} from '../lib/ingest/evidence-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUE_SLUG = 'bamsbl';

const PILOT_QUERIES = [
  'courtesy runner rule',
  'infield fly',
  'dropped third strike',
  'balk penalty',
  'time limit',
  'cleat requirements',
  'pitching limits',
  'can a pitcher wear sunglasses',
  'coach mound visits',
  'interference by catcher',
  'collision rule must slide',
  'home run over fence',
  'batting out of order',
  'illegal pitch',
  'protest a call',
  'mercy rule',
  'extra innings tiebreaker',
  'pitcher re-entry',
  'obstruction on base paths',
  'uniform jersey requirements',
];

function loadLocalEnv() {
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
}

async function embedQuestion(openai, question) {
  const result = await openai.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    input: question,
    dimensions: 1536,
  });
  const embedding = result.data[0]?.embedding;
  if (!embedding || embedding.length !== 1536) {
    throw new Error(`Invalid embedding for query: ${question}`);
  }
  return vectorLiteral(embedding);
}

function topRuleCodes(chunkHits, limit = 3) {
  const seen = new Set();
  const codes = [];
  for (const hit of chunkHits) {
    const code = hit.rule_number ?? '—';
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
    if (codes.length >= limit) break;
  }
  while (codes.length < limit) codes.push('—');
  return codes;
}

function padEnd(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s.slice(0, len - 1) + '…' : s + ' '.repeat(len - s.length);
}

async function main() {
  loadLocalEnv();
  if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
    console.error('DATABASE_URL and OPENAI_API_KEY are required.');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const { rows: [league] } = await client.query(`
      SELECT rv.id AS version_id, l.name AS league_name
      FROM leagues l
      JOIN rulebook_versions rv ON rv.league_id = l.id AND rv.status = 'active'
      WHERE l.slug = $1
      LIMIT 1
    `, [LEAGUE_SLUG]);

    if (!league) {
      console.error(`No active version for league "${LEAGUE_SLUG}".`);
      process.exit(1);
    }

    console.log(`BAMSBL pilot retrieval baseline (${PILOT_QUERIES.length} queries)`);
    console.log(`League: ${league.league_name}`);
    console.log(`Version: ${league.version_id}`);
    console.log(`Method: evidence_bundle_dual_path_hybrid\n`);

    const rows = [];

    for (const query of PILOT_QUERIES) {
      const embedding = await embedQuestion(openai, query);
      const { chunkHits, method, bundles } = await fetchEvidenceBundles(client, league.version_id, query, {
        queryEmbedding: embedding,
        limit: 3,
      });

      const sorted = [...(chunkHits ?? [])].sort(
        (a, b) => Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0),
      );
      const [r1, r2, r3] = topRuleCodes(sorted, 3);
      const topScore = bestEvidenceScore(bundles.length ? bundles : sorted);

      rows.push({
        query,
        r1,
        r2,
        r3,
        topScore,
        method,
      });
    }

    const qCol = Math.max(34, ...rows.map((r) => r.query.length + 2));
    const header = `${padEnd('Query', qCol)} | Top-1 | Top-2 | Top-3 | Best Score`;
    const rule = '-'.repeat(header.length);

    console.log(header);
    console.log(rule);
    for (const r of rows) {
      console.log(
        `${padEnd(r.query, qCol)} | ${padEnd(r.r1, 5)} | ${padEnd(r.r2, 5)} | ${padEnd(r.r3, 5)} | ${r.topScore.toFixed(4)}`,
      );
    }

    console.log(`\nEvaluated ${rows.length} queries.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
