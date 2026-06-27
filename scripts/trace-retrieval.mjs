/**
 * Trace the production Evidence Bundle retrieval + draft + verifier pipeline.
 *
 * Usage:
 *   node scripts/trace-retrieval.mjs
 *   node scripts/trace-retrieval.mjs "is there a uniform rule?"
 */

import pg from 'pg';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
  fetchEvidenceBundles,
  formatEvidenceBundlesForPrompt,
  formatEvidenceBundlesForVerifier,
  buildOrFallbackQuery,
  vectorLiteral,
} from '../lib/ingest/evidence-bundle.js';
import { LLM_ANSWER_MODEL, LLM_VERIFY_MODEL } from '../lib/llm-models.js';
import { VERIFIER_SYSTEM_PROMPT } from '../api/verifier.js';

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
  } catch {}
}

loadLocalEnv();

const QUESTION = process.argv.slice(2).join(' ').trim() || 'is there a uniform rule?';
const LEAGUE_SLUG = 'bamsbl';
const LINE = '─'.repeat(78);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function main() {
  const client = await pool.connect();
  try {
    console.log(LINE);
    console.log(`TRACE: ${QUESTION}`);
    console.log(LINE);

    const { rows: [active] } = await client.query(`
      SELECT rv.id AS version_id
      FROM rulebook_versions rv
      JOIN leagues l ON l.id = rv.league_id
      WHERE l.slug=$1 AND rv.status='active'
    `, [LEAGUE_SLUG]);
    if (!active) throw new Error('No active BAMSBL rulebook version.');
    console.log(`\n[STEP 0] Active version: ${active.version_id}`);

    const orTerms = buildOrFallbackQuery(QUESTION);
    const { rows: [strict] } = await client.query(
      `SELECT plainto_tsquery('english', $1)::text AS q`,
      [QUESTION],
    );
    const { rows: [orq] } = await client.query(
      `SELECT CASE WHEN $1::text = '' THEN '' ELSE to_tsquery('english', $1)::text END AS q`,
      [orTerms],
    );
    console.log(`\n[STEP 1] Lexical queries`);
    console.log(`  plainto_tsquery: ${strict.q}`);
    console.log(`  OR terms: "${orTerms}"`);
    console.log(`  to_tsquery: ${orq.q}`);

    console.log(`\n[STEP 2] Creating query embedding`);
    const embeddingResult = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: QUESTION,
      dimensions: 1536,
    });
    const queryEmbedding = vectorLiteral(embeddingResult.data[0].embedding);
    console.log(`  embedding dimensions: ${embeddingResult.data[0].embedding.length}`);

    console.log(`\n[STEP 3] Hybrid vector + FTS rule_node_chunks retrieval`);
    const { bundles, method, chunkHits, extraction_run_id } = await fetchEvidenceBundles(
      client,
      active.version_id,
      QUESTION,
      { queryEmbedding },
    );
    console.log(`  extraction_run_id: ${extraction_run_id}`);
    console.log(`  method: ${method}`);
    console.log(`  chunk hit count: ${chunkHits.length}`);
    for (const [i, hit] of chunkHits.slice(0, 8).entries()) {
      console.log(`  chunk#${i + 1} rule=${hit.rule_number ?? '(none)'} node_type=${hit.node_type} vector=${Number(hit.vector_score ?? 0).toFixed(4)} hybrid=${Number(hit.hybrid_score ?? 0).toFixed(4)}`);
      console.log(`           chunk_text=${JSON.stringify(String(hit.chunk_text).slice(0, 100))}`);
    }

    console.log(`\n[STEP 4] Evidence Bundles assembled (${bundles.length})`);
    for (const [i, b] of bundles.entries()) {
      console.log(`\n  Bundle #${i + 1}`);
      console.log(`    bundle_id:     ${b.bundle_id}`);
      console.log(`    rule_number:   ${b.rule_number ?? '(none)'}`);
      console.log(`    node_type:     ${b.node_type}`);
      console.log(`    ancestor_path: ${b.ancestor_path || '(root)'}`);
      console.log(`    page:          ${b.page_start ?? '?'}–${b.page_end ?? '?'}`);
      console.log(`    hybrid_score:  ${Number(b.hybrid_score).toFixed(4)}`);
      console.log(`    matched_chunk: ${JSON.stringify(String(b.matched_chunk_text).slice(0, 120))}`);
      console.log(`    annotations:   ${b.annotations?.length ?? 0}`);
      console.log(`    canonical_text:`);
      console.log('    """');
      console.log(b.canonical_text.split('\n').map(l => `    ${l}`).join('\n'));
      console.log('    """');
    }

    const rule305 = bundles.find(b => b.rule_number === '305');
    console.log(`\n[STEP 4b] Rule 305 isolation check`);
    if (rule305) {
      console.log(`  ✓ Rule 305 present in bundles (rank #${bundles.indexOf(rule305) + 1})`);
      console.log(`  title: ${rule305.title}`);
      console.log(`  path:  ${rule305.ancestor_path}`);
    } else {
      console.log(`  ✗ Rule 305 NOT in top ${bundles.length} bundles`);
      const chunk305 = chunkHits.find(h => h.rule_number === '305');
      if (chunk305) {
        console.log(`  (Rule 305 chunk exists in hits at hybrid=${Number(chunk305.hybrid_score).toFixed(4)} but was deduped/outranked)`);
      }
    }

    const answerPrompt = formatEvidenceBundlesForPrompt(bundles);
    const fullPrompt = `You are an expert baseball rules official for the Bay Area Men's Senior Baseball League.

Your job: answer the umpire's question using ONLY the Evidence Bundles shown below.

EVIDENCE BUNDLES (${bundles.length} retrieved):
${answerPrompt}

QUESTION: ${QUESTION}

Answer:`;

    console.log(`\n[STEP 5] Exact draft prompt sent to Sonnet`);
    console.log(LINE);
    console.log(fullPrompt);
    console.log(LINE);

    console.log(`\n[STEP 6] Calling draft model`);
    const draft = await anthropic.messages.create({
      model: LLM_ANSWER_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: fullPrompt }],
    });
    const draftAnswer = draft.content[0]?.text?.trim() || '';
    console.log('\nDRAFT ANSWER:');
    console.log(LINE);
    console.log(draftAnswer);
    console.log(LINE);

    const verifierPrompt = `DRAFT ANSWER TO VERIFY:
${draftAnswer}

ALLOWED EVIDENCE BUNDLES:
${formatEvidenceBundlesForVerifier(bundles)}

Verify every factual claim in the draft answer against the evidence bundles above.
Return JSON only.`;

    console.log(`\n[STEP 7] Exact verifier prompt sent to Opus`);
    console.log(LINE);
    console.log(verifierPrompt);
    console.log(LINE);

    console.log(`\n[STEP 8] Calling verifier`);
    const verifier = await anthropic.messages.create({
      model: LLM_VERIFY_MODEL,
      max_tokens: 4096,
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: verifierPrompt }],
    });
    const verifierRaw = verifier.content[0]?.text?.trim() || '';
    console.log('\nVERIFIER RAW RESPONSE:');
    console.log(LINE);
    console.log(verifierRaw);
    console.log(LINE);

    let parsed = null;
    try {
      parsed = JSON.parse(verifierRaw.slice(verifierRaw.indexOf('{'), verifierRaw.lastIndexOf('}') + 1));
    } catch {}
    const blocked = !parsed || parsed.status === 'unsupported' || (parsed.unsupported_claims?.length ?? 0) > 0;
    console.log(`\n[STEP 9] GATE RESULT`);
    console.log(`  verifier_status: ${parsed?.status ?? 'PARSE_ERROR'}`);
    console.log(`  unsupported_claims: ${JSON.stringify(parsed?.unsupported_claims ?? [])}`);
    console.log(`  BLOCKED: ${blocked}`);
    console.log(`  USER WOULD SEE: ${blocked ? 'blocked / unverifiable' : 'answer delivered'}`);
    console.log('\n' + LINE);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
