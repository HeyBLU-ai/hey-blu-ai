#!/usr/bin/env node
/**
 * Baseline retrieval accuracy eval for BAMSBL pilot queries.
 * Uses the same dual-path hybrid search as ask-v2 (primary rulebook only).
 *
 * Grading (when `expected` is set):
 *   PASS — expected rule is Top-1
 *   WARN — expected rule is Top-2 or Top-3 only
 *   FAIL — expected rule missing from Top-3
 *   SKIP — no local expected rule (trimmed rulebook has no governing rule; MLB fallback expected)
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

/**
 * Expected rule numbers for the trimmed BAMSBL rulebook (rules 420–550).
 * Set to null when no local rule exists and MLB fallback is the correct path.
 */
const PILOT_CASES = [
  { query: 'courtesy runner rule', expected: ['430'] },
  { query: 'infield fly', expected: null },
  { query: 'dropped third strike', expected: null },
  { query: 'balk penalty', expected: null },
  { query: 'time limit', expected: ['445'] },
  { query: 'cleat requirements', expected: null },
  { query: 'pitching limits', expected: null },
  { query: 'can a pitcher wear sunglasses', expected: null },
  { query: 'coach mound visits', expected: null },
  { query: 'interference by catcher', expected: ['440'] },
  { query: 'collision rule must slide', expected: ['505'] },
  { query: 'home run over fence', expected: null },
  { query: 'batting out of order', expected: ['420'] },
  { query: 'illegal pitch', expected: null },
  { query: 'protest a call', expected: ['470'] },
  { query: 'mercy rule', expected: null },
  { query: 'extra innings tiebreaker', expected: null },
  { query: 'pitcher re-entry', expected: null },
  { query: 'obstruction on base paths', expected: ['505'] },
  { query: 'uniform jersey requirements', expected: null },
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

/**
 * @param {string[]|null} expected
 * @param {string[]} topCodes
 */
function gradeResult(expected, topCodes) {
  if (!expected?.length) return 'SKIP';
  const [r1, r2, r3] = topCodes;
  if (expected.includes(r1)) return 'PASS';
  if (expected.includes(r2) || expected.includes(r3)) return 'WARN';
  return 'FAIL';
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

  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };

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

    console.log(`BAMSBL pilot retrieval baseline (${PILOT_CASES.length} queries)`);
    console.log(`League: ${league.league_name}`);
    console.log(`Version: ${league.version_id}`);
    console.log(`Method: evidence_bundle_dual_path_hybrid\n`);

    const rows = [];

    for (const testCase of PILOT_CASES) {
      const { query, expected } = testCase;
      const embedding = await embedQuestion(openai, query);
      const { chunkHits, bundles } = await fetchEvidenceBundles(client, league.version_id, query, {
        queryEmbedding: embedding,
        limit: 3,
      });

      const sorted = [...(chunkHits ?? [])].sort(
        (a, b) => Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0),
      );
      const topCodes = topRuleCodes(sorted, 3);
      const [r1, r2, r3] = topCodes;
      const topScore = bestEvidenceScore(bundles.length ? bundles : sorted);
      const status = gradeResult(expected, topCodes);
      counts[status] += 1;

      rows.push({
        query,
        expected: expected?.join(',') ?? '—',
        r1,
        r2,
        r3,
        topScore,
        status,
      });
    }

    const qCol = Math.max(30, ...rows.map((r) => r.query.length + 2));
    const header = `${padEnd('Query', qCol)} | Expect | Top-1 | Top-2 | Top-3 | Score  | Grade`;
    const rule = '-'.repeat(header.length);

    console.log(header);
    console.log(rule);
    for (const r of rows) {
      console.log(
        `${padEnd(r.query, qCol)} | ${padEnd(r.expected, 6)} | ${padEnd(r.r1, 5)} | ${padEnd(r.r2, 5)} | ${padEnd(r.r3, 5)} | ${r.topScore.toFixed(4)} | ${r.status}`,
      );
    }

    console.log(`\nSummary: PASS=${counts.PASS}  WARN=${counts.WARN}  FAIL=${counts.FAIL}  SKIP=${counts.SKIP}`);

    if (counts.FAIL > 0) {
      console.error('\n✗ Retrieval regressions detected (FAIL).');
      process.exit(1);
    }

    console.log('\n✓ No FAIL grades.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
