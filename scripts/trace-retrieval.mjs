/**
 * Trace the production rule_units retrieval + draft + verifier pipeline.
 *
 * Usage:
 *   node scripts/trace-retrieval.mjs
 */

import pg from 'pg';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
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
  } catch {}
}

loadLocalEnv();

const QUESTION = process.argv.slice(2).join(' ').trim() || 'is there a uniform rule?';
const LEAGUE_SLUG = 'bamsbl';
const LINE = '─'.repeat(78);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FTS_STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','dare','ought','used',
  'i','me','my','we','our','you','your','he','his','she','her','it','its',
  'they','their','them','this','that','these','those','who','which','what',
  'when','where','why','how','and','but','or','nor','for','yet','so',
  'in','on','at','to','of','by','from','up','about','into','through',
  'there','here','not','no','if','then','than','as','with','any','all',
  'rule','rules','ruling','rulings','league','leagues',
]);

function buildOrFallbackQuery(question) {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !FTS_STOP_WORDS.has(w));
  return [...new Set(words)].join(' | ');
}

function vectorLiteral(values) {
  return `[${values.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

function buildAnswerPrompt(units) {
  const excerptBlock = units.length === 0
    ? '(No matching rule units found in the rulebook for this question. You must respond that no applicable rule was found.)'
    : units.map((u, i) => {
        const page = u.page_start != null ? ` — p.${u.page_start}` : '';
        return `[Source ${i + 1}] Rule ${u.rule_number}${page}:\n"${u.full_text}"`;
      }).join('\n\n');

  return `You are an expert baseball rules official for the Bay Area Men's Senior Baseball League.

Your job: answer the umpire's question using ONLY the complete rulebook rule units shown below.

RULEBOOK RULE UNITS (${units.length} retrieved):
${excerptBlock}

QUESTION: ${QUESTION}

Instructions:
- Answer ONLY from the rule units above. Do NOT cite, invent, or infer rules that do not appear in the rule units.
- If no rule unit covers the question, respond with exactly: "I could not find an applicable rule for that question in the BAMSBL rulebook."
- Never mention retrieval internals or source availability. Forbidden phrases include: "excerpts I have access to", "retrieved portions", "loaded rulebook", "based on what was provided", "I only have", and "the excerpts show".
- Otherwise, structure your response in EXACTLY these two parts, in this order, with these exact headings:

**The Ruling:** Write a conversational, plain-English explanation that an umpire can understand and act on immediately. You may paraphrase lightly here to make the rule clear, but every factual claim must be grounded in the rule units.

**The Book:** On a new line after The Ruling, provide the official citation(s) using this exact format:

**Official Rule [Number] (p.[Page]):** "[Exact verbatim quote from the rule unit]"

CRITICAL rules for The Book citation:
- Use the rule number exactly as it appears in the source label.
- The quoted text MUST be copied character-for-character from the rule unit.
- Every factual rule requirement mentioned in The Ruling must have a matching citation line in The Book. If you mention a pitcher-specific uniform rule, cite that pitcher rule too.
- Never add words or ellipses inside the quote that are not in the original.

Answer:`;
}

function buildVerifierPrompt(draftAnswer, units) {
  const sourceBlock = units
    .map(u => `[Source ${u.id}]\nRule ${u.rule_number}:\n"${u.full_text}"`)
    .join('\n\n');

  return `DRAFT ANSWER TO VERIFY:
${draftAnswer}

ALLOWED SOURCE EXCERPTS:
${sourceBlock}

Verify every factual claim in the draft answer against the source excerpts above.
Return JSON only.`;
}

const VERIFIER_SYSTEM_PROMPT = `You are a strict fact-checking verifier for a baseball rules Q&A system.

You will receive:
1. A DRAFT ANSWER produced by an AI assistant.
2. ALLOWED SOURCE EXCERPTS — verbatim passages from the official rulebook.

Your task: for every factual claim in the draft answer, determine whether it is
directly and explicitly stated in the provided source excerpts.

CRITICAL RULES:
- Use ONLY the provided source excerpts. Do NOT draw on your own baseball knowledge.
- A claim is "supported" only if a source excerpt explicitly states the same fact.
- Reasonable inferences and implications do NOT count as supported.
- If the draft correctly says no applicable rule was found, return status "no_rule_found".

PARTIAL OR INCOMPLETE SOURCE TEXT:
- If every claim the draft actually makes is backed by the source text, return "approved" — even if the answer is incomplete relative to the full rule.
- If the draft is correct but explicitly notes that details are missing or that the full rule could not be found in the retrieved text, return "needs_fact".
- Reserve "unsupported" ONLY for answers that assert or invent facts that are NOT present anywhere in the provided source excerpts, or that directly contradict the sources.

Return ONLY valid JSON — no preamble, no markdown:
{
  "status": "approved" | "unsupported" | "needs_fact" | "no_rule_found",
  "claims": [
    {
      "claim": "<exact factual claim from the draft>",
      "supported": true | false,
      "source_ids": ["<uuid of supporting source, or empty array if unsupported>"]
    }
  ],
  "unsupported_claims": ["<verbatim list of unsupported claim texts>"],
  "confidence": "high" | "medium" | "low"
}`;

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

    console.log(`\n[STEP 3] Hybrid vector + FTS rule_units retrieval`);
    const { rows: units } = await client.query(`
      WITH vector_candidates AS (
        SELECT
          id,
          rule_number,
          title,
          full_text,
          page_start,
          page_end,
          source_ids,
          1 - (embedding <=> $3::vector) AS vector_score,
          ts_rank(search_vector, plainto_tsquery('english', $1)) AS strict_fts_score,
          CASE
            WHEN $4::text = '' THEN 0
            ELSE ts_rank(search_vector, to_tsquery('english', $4))
          END AS or_fts_score
        FROM rule_units
        WHERE rulebook_version_id = $2
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $3::vector
        LIMIT 20
      )
      SELECT *,
        (
          vector_score * 0.75 +
          greatest(strict_fts_score, or_fts_score) * 0.25 +
          CASE WHEN lower($1) LIKE '%' || lower(rule_number) || '%' THEN 0.15 ELSE 0 END
        ) AS hybrid_score
      FROM vector_candidates
      ORDER BY hybrid_score DESC, vector_score DESC
      LIMIT 3
    `, [QUESTION, active.version_id, queryEmbedding, orTerms]);

    console.log(`  result count: ${units.length}`);
    for (const [i, u] of units.entries()) {
      console.log(`  #${i + 1} rule=${u.rule_number} title=${u.title ?? '(untitled)'} vector=${Number(u.vector_score).toFixed(4)} fts=${Number(Math.max(u.strict_fts_score, u.or_fts_score)).toFixed(4)} hybrid=${Number(u.hybrid_score).toFixed(4)}`);
      console.log(`     text=${JSON.stringify(u.full_text)}`);
    }

    const answerPrompt = buildAnswerPrompt(units);
    console.log(`\n[STEP 4] Exact draft prompt sent to Sonnet`);
    console.log(LINE);
    console.log(answerPrompt);
    console.log(LINE);

    console.log(`\n[STEP 5] Calling draft model`);
    const draft = await anthropic.messages.create({
      model: process.env.ANTHROPIC_ANSWER_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: answerPrompt }],
    });
    const draftAnswer = draft.content[0]?.text?.trim() || '';
    console.log('\nDRAFT ANSWER:');
    console.log(LINE);
    console.log(draftAnswer);
    console.log(LINE);

    const verifierPrompt = buildVerifierPrompt(draftAnswer, units);
    console.log(`\n[STEP 6] Exact verifier prompt sent to Opus`);
    console.log(LINE);
    console.log(verifierPrompt);
    console.log(LINE);

    console.log(`\n[STEP 7] Calling verifier`);
    const verifier = await anthropic.messages.create({
      model: process.env.ANTHROPIC_VERIFY_MODEL || 'claude-opus-4-8',
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
    console.log(`\n[STEP 8] GATE RESULT`);
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
