/**
 * /api/ask-v2 — Active Interviewer endpoint
 *
 * Extends the single-shot RAG in ask.js with a three-state routing layer:
 *
 *   State A (answered)           — Factual question. Standard RAG answer, no interruption.
 *   State B (needs_clarification)— Judgment-call play. Returns a structured diagnostic
 *                                   question. Client echoes back answers in matrix_state.
 *   State C (ruling)             — All interview answers collected. RAG runs with
 *                                   play-context injected into the prompt, producing
 *                                   a context-aware ruling.
 *
 * Request body:
 *   question     {string}  — the umpire's question (required)
 *   league       {string}  — league slug (required; unknown or missing → 404 league_not_found)
 *   conversation {Array}   — prior Q/A turns for context (optional)
 *   matrix_state {object}  — present on follow-up requests during an interview:
 *                             { matrix_id: string, answers: { [question_id]: string } }
 *
 * Response shapes:
 *   State A: { state: "answered",            reply, league_slug, active_version_id,
 *               retrieved_source_ids, cited_rule_numbers }
 *   State B: { state: "needs_clarification", matrix_id, matrix_label, current_question,
 *               progress: { answered, remaining_estimated } }
 *   State C: { state: "ruling",              reply, league_slug, active_version_id,
 *               retrieved_source_ids, cited_rule_numbers, matrix_id, answers_used }
 */

import path           from "path";
import { fileURLToPath } from 'url';
import { dirname }    from 'path';
import pg             from 'pg';
import {
  JUDGMENT_MATRICES,
  findMatrix,
  getNextQuestion,
  buildRulingContext,
  prescreenForMatrix,
} from './judgment-matrices.js';

const { Client, Pool } = pg;
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);

// ── Shared DB pool (used by runRAG + logToDb) ────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// Minimum classifier confidence to trigger an interview (below → fall through to RAG)
const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.65;

// ── CORS Middleware ──────────────────────────────────────────────────────────

const withCors = (handler) => async (req, res) => {
  const origin = req.headers.origin || '';
  if (
    origin === 'https://heyblu.ai'    ||
    origin === 'https://www.heyblu.ai' ||
    origin.endsWith('.vercel.app')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return handler(req, res);
};

// ── Utility Functions (mirrors ask.js for security parity) ──────────────────

function extractRuleRef(answer) {
  const lines = answer.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const m = lines[1].match(/([0-9]+\.[0-9]+[a-z]?\([0-9]+\)|[0-9]+\.[0-9]+[a-z]?)/i);
    if (m?.[1]) return m[1];
  }
  const m = answer.match(/([0-9]+\.[0-9]+[a-z]?\([0-9]+\)|[0-9]+\.[0-9]+[a-z]?)/i);
  return m?.[1] ?? '';
}


function sanitizeInput(input, maxLength = 5000) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().slice(0, maxLength).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}

function validateConversation(conversation) {
  if (!conversation || !Array.isArray(conversation)) return [];
  return conversation
    .slice(0, 10)
    .map(turn => {
      if (!turn || typeof turn !== 'object') return null;
      return { user: sanitizeInput(turn.user, 1000), ai: sanitizeInput(turn.ai, 2000) };
    })
    .filter(t => t?.user && t?.ai);
}

/** Sanitize and validate the incoming matrix_state object. */
function validateMatrixState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.matrix_id !== 'string' || !raw.matrix_id) return null;
  if (!raw.answers || typeof raw.answers !== 'object') return null;

  const answers = {};
  for (const [k, v] of Object.entries(raw.answers)) {
    if (typeof k === 'string' && typeof v === 'string') {
      answers[sanitizeInput(k, 100)] = sanitizeInput(v, 200);
    }
  }

  return {
    matrix_id: sanitizeInput(raw.matrix_id, 100),
    answers,
  };
}

// ── League Mapping ───────────────────────────────────────────────────────────

/**
 * Maps a league string (from the client) to the DB slug and display name.
 */
/**
 * Maps common league name strings to their DB slug.
 * The DB is the authority — unknown slugs produce a league_not_found error
 * in runRAG rather than silently defaulting to MLB.
 */
function resolveLeague(league) {
  const leagueNorm = sanitizeInput(league ?? '', 50).toLowerCase().trim();
  if (!leagueNorm) throw new LeagueNotFoundError('A league must be specified. No rulebook is loaded for an empty or missing league value.');
  if (leagueNorm === 'usssa' || leagueNorm === 'usssa baseball')                      return { slug: 'usssa',          leagueName: 'USSSA Baseball' };
  if (leagueNorm === 'little league' || leagueNorm === 'little league international') return { slug: 'little-league',  leagueName: 'Little League International' };
  if (leagueNorm === 'mill valley aaa' || leagueNorm === 'mill valley')               return { slug: 'mill-valley-aaa', leagueName: 'Mill Valley AAA' };
  if (leagueNorm === 'bamsbl')                                                         return { slug: 'bamsbl',         leagueName: 'Bay Area Men\'s Senior Baseball League' };
  if (leagueNorm === 'mlb' || leagueNorm === 'mlb official rules of baseball')       return { slug: 'mlb',            leagueName: 'MLB Official Rules of Baseball' };
  // Unknown league — pass through as-is; DB check in runRAG will return 404.
  return { slug: leagueNorm, leagueName: league };
}

// ── Typed errors ─────────────────────────────────────────────────────────────
class LeagueNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.type = 'league_not_found';
  }
}

/** Thrown when the league exists in the DB but has no ACTIVE rulebook_version. */
class RulebookNotActiveError extends Error {
  constructor(message) {
    super(message);
    this.type = 'rulebook_not_active';
  }
}

// ── Anthropic client ─────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { runVerifier, isVerifierBlocked } from './verifier.js';

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ── Play-Type Classifier ─────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `\
You are a baseball rules routing assistant. Classify whether an umpire's question requires additional play context — a "judgment call" that depends on circumstantial factors — or is a straightforward factual lookup.

JUDGMENT CALL CATEGORIES (require extra context to rule correctly):
- runner_fielder_collision : Physical contact between a runner and fielder — obstruction, interference, or collision
- infield_fly_rule         : Whether the infield fly rule applies to a specific play
- dropped_third_strike     : Whether a batter-runner may advance on a dropped/uncaught third strike
- check_swing_hbp          : Check-swing ruling, or hit-by-pitch award determination
- fair_foul_ball           : Fair/foul call for a ball hit near the base lines
- appeal_play              : Whether an appeal play was valid or properly executed
- force_vs_tag             : Whether a force play or a tag is required on a specific play

FACTUAL (no extra context needed — answer directly from the rulebook):
- Distances, field dimensions, measurements
- Pitch count limits, innings pitched rules
- Equipment specifications
- Number of players on the field
- Pure definitions of terms (what is the infield fly rule?)
- Any question that can be answered without knowing the specific sequence of events

Respond with JSON only. Do not include any other text.`;

/**
 * Calls GPT-4o-mini to confirm whether the question is a judgment call.
 * Returns { classification, matrix_id, confidence } or null on failure.
 *
 * This is only called when the keyword pre-screen finds a potential match.
 * It confirms the match and identifies the precise matrix.
 */
async function classifyQuestion(question) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 150,
      system:     CLASSIFIER_SYSTEM_PROMPT,
      messages:   [{
        role:    'user',
        content: `Question: "${question}"\n\nReturn JSON: { "classification": "judgment"|"factual", "matrix_id": string|null, "confidence": 0.0-1.0, "reasoning": "one sentence" }`,
      }],
    });
    const text   = msg.content[0]?.text ?? '';
    const start  = text.indexOf('{');
    const end    = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed.classification !== 'string') return null;
    return parsed;
  } catch (err) {
    console.warn('[ask-v2] Classifier failed (falling through to RAG):', err.message);
    return null;
  }
}

// ── V3 Source-Span RAG Pipeline ───────────────────────────────────────────────
//
// Three-step retrieval:
//   1. resolveActiveVersion  — look up league + active rulebook_versions row.
//      Throws LeagueNotFoundError if the league does not exist in the DB.
//      Throws RulebookNotActiveError if the league exists but has no ACTIVE version.
//
//   2. fetchSourceSpans      — Postgres full-text search on rule_sources.exact_text,
//      filtered strictly to rows that belong to the active version.
//      Falls back to an empty span list if FTS produces no results (letting the
//      model say "I could not find a specific rule" rather than hallucinating).
//
//   3. Prompt construction   — builds the Claude prompt from verbatim source spans
//      only. The model cannot see rules that are not returned by the FTS step.
//
// Response metadata (always present):
//   league_slug, active_version_id, retrieved_source_ids, cited_rule_numbers
//
// Debug metadata (present when RULEBOOK_DEBUG=1):
//   _debug.retrieval_method, _debug.span_count, _debug.spans[]

/**
 * Looks up the league row and its single ACTIVE rulebook_version.
 *
 * @param {pg.PoolClient} dbClient
 * @param {string}        leagueSlug
 * @returns {{ leagueId, leagueName, activeVersionId }}
 * @throws {LeagueNotFoundError}   if no leagues row with that slug exists.
 * @throws {RulebookNotActiveError} if the league exists but has no active version.
 */
async function resolveActiveVersion(dbClient, leagueSlug) {
  const res = await dbClient.query(`
    SELECT l.id         AS league_id,
           l.name       AS league_name,
           rv.id        AS version_id
    FROM   leagues l
    LEFT   JOIN rulebook_versions rv
             ON rv.league_id = l.id AND rv.status = 'active'
    WHERE  l.slug = $1
  `, [leagueSlug]);

  if (res.rows.length === 0) {
    throw new LeagueNotFoundError(
      `No rulebook is loaded for league "${leagueSlug}". ` +
      `Select a different league or contact an admin.`,
    );
  }

  const { league_id, league_name, version_id } = res.rows[0];

  if (!version_id) {
    throw new RulebookNotActiveError(
      `No active rulebook is loaded for "${league_name}". ` +
      `An admin must activate a rulebook version before questions can be answered.`,
    );
  }

  return { leagueId: league_id, leagueName: league_name, activeVersionId: version_id };
}

/**
 * Retrieves up to 8 source spans relevant to the question using Postgres FTS.
 *
 * Only spans whose rule_documents.version_id AND rules.rulebook_version_id both
 * equal activeVersionId are considered — this guarantees no legacy NULL-version
 * spans can appear in the results.
 *
 * If FTS returns zero results (stop-word-only query, no matches, or FTS error),
 * the function returns an empty array so the caller can handle the no-results case.
 *
 * @param {pg.PoolClient} dbClient
 * @param {string}        activeVersionId
 * @param {string}        question         Plain-text question (used for plainto_tsquery)
 * @returns {{ spans: Object[], method: string }}
 */
// English stop words excluded from the OR-fallback keyword extraction.
// IMPORTANT: "rule" / "rules" / "ruling" are deliberately included here.
// Every question to this app is a rules question, so those words appear in
// virtually every source span and produce zero discriminating signal.
// Including them in an OR query causes noise spans ("This rule is not…")
// to rank above the actual subject-matter spans (uniforms, collisions, etc.).
const FTS_STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','dare','ought','used',
  'i','me','my','we','our','you','your','he','his','she','her','it','its',
  'they','their','them','this','that','these','those','who','which','what',
  'when','where','why','how','and','but','or','nor','for','yet','so',
  'in','on','at','to','of','by','from','up','about','into','through',
  'there','here','not','no','if','then','than','as','with','any','all',
  // Rulebook-specific noise: appear in every span, provide no discrimination
  'rule','rules','ruling','rulings','league','leagues',
]);

/**
 * Extract the most meaningful content words from a question for the FTS
 * OR-fallback query.  Returns words longer than 3 chars that are not stop
 * words, joined with ' | ' for use in to_tsquery().
 */
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

async function embedQuestion(question) {
  if (!openai) return null;
  try {
    const result = await openai.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: question,
      dimensions: 1536,
    });
    const embedding = result.data[0]?.embedding;
    return embedding?.length === 1536 ? vectorLiteral(embedding) : null;
  } catch (err) {
    console.warn('[ask-v2] Question embedding failed — using lexical rule_units retrieval:', err.message);
    return null;
  }
}

function ruleUnitRowToSpan(row) {
  return {
    source_id:    row.unit_id,
    unit_id:      row.unit_id,
    exact_text:   row.full_text,
    page_start:   row.page_start,
    page_end:     row.page_end,
    section_path: row.title,
    rule_numbers: row.rule_number,
    source_ids:   row.source_ids ?? [],
    rank:         Number(row.rank ?? row.hybrid_score ?? row.vector_score ?? row.fts_score ?? 0),
  };
}

async function fetchSourceSpans(dbClient, activeVersionId, question) {
  const orTerms = buildOrFallbackQuery(question);
  const embedding = await embedQuestion(question);

  try {
    if (embedding) {
      const res = await dbClient.query(`
        WITH vector_candidates AS (
          SELECT
            id AS unit_id,
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
      `, [question, activeVersionId, embedding, orTerms]);

      if (res.rows.length > 0) {
        return {
          spans:  res.rows.map(ruleUnitRowToSpan),
          method: 'rule_units_vector_hybrid',
        };
      }
    }

    const lexical = await dbClient.query(`
      SELECT
        id AS unit_id,
        rule_number,
        title,
        full_text,
        page_start,
        page_end,
        source_ids,
        greatest(
          ts_rank(search_vector, plainto_tsquery('english', $1)),
          CASE
            WHEN $3::text = '' THEN 0
            ELSE ts_rank(search_vector, to_tsquery('english', $3))
          END
        ) AS rank
      FROM rule_units
      WHERE rulebook_version_id = $2
        AND (
          search_vector @@ plainto_tsquery('english', $1)
          OR ($3::text <> '' AND search_vector @@ to_tsquery('english', $3))
        )
      ORDER BY rank DESC
      LIMIT 3
    `, [question, activeVersionId, orTerms]);

    return {
      spans:  lexical.rows.map(ruleUnitRowToSpan),
      method: lexical.rows.length > 0 ? 'rule_units_fts' : 'rule_units_no_match',
    };
  } catch (err) {
    console.warn('[ask-v2] rule_units retrieval failed — returning empty spans:', err.message);
    return { spans: [], method: 'rule_units_error' };
  }
}

/**
 * Build the Claude prompt from verbatim source span excerpts.
 *
 * The model is instructed to answer ONLY from the excerpts shown — it cannot
 * fabricate rules or reference content that was not retrieved.
 */
function buildSpanPrompt({ spans, leagueName, sanitizedQuestion, extraContext, conversation }) {
  const validatedConversation = validateConversation(conversation);
  const historyText = validatedConversation.length > 0
    ? 'Prior conversation:\n' +
      validatedConversation.map(t => `Umpire: ${t.user}\nOfficial: ${t.ai}`).join('\n\n') + '\n\n'
    : '';

  let excerptBlock;
  if (spans.length === 0) {
    excerptBlock =
      '(No matching source excerpts found in the rulebook for this question. ' +
      'You must respond that no specific rule was found.)';
  } else {
    excerptBlock = spans.map((s, i) => {
      const ruleRef    = (s.rule_numbers ?? '').replace(/,/g, ' /').trim() || 'Unnumbered';
      const pageNote   = s.page_start != null ? ` — p.${s.page_start}` : '';
      const sectionNote = s.section_path ? ` — ${s.section_path}` : '';
      return `[Source ${i + 1}] Rule ${ruleRef}${pageNote}${sectionNote}:\n"${s.exact_text}"`;
    }).join('\n\n');
  }

  return `You are an expert baseball rules official for the ${leagueName}.

Your job: answer the umpire's question using ONLY the complete rulebook rule units shown below.

${extraContext ? `PLAY CONTEXT:\n${extraContext}\n\n` : ''}\
${historyText}\
RULEBOOK RULE UNITS (${spans.length} retrieved):
${excerptBlock}

QUESTION: ${sanitizedQuestion}

Instructions:
- Answer ONLY from the rule units above. Do NOT cite, invent, or infer rules that do not appear in the rule units.
- If no rule unit covers the question, respond with exactly: "I could not find an applicable rule for that question in the BAMSBL rulebook."
- Never mention retrieval internals or source availability. Forbidden phrases include: "excerpts I have access to", "retrieved portions", "loaded rulebook", "based on what was provided", "I only have", and "the excerpts show".
- Otherwise, structure your response in EXACTLY these two parts, in this order, with these exact headings:

**The Ruling:** Write a conversational, plain-English explanation that an umpire can understand and act on immediately. You may paraphrase lightly here to make the rule clear, but every factual claim must be grounded in the rule units.

**The Book:** On a new line after The Ruling, provide the official citation(s) using these exact formats:

- If the source excerpt has a clear rule number (e.g. "505", "4.01"): **Official Rule [Number] (p.[Page]):** "[Exact verbatim quote from the source excerpt]"
- If the source excerpt has no rule number, or has a placeholder like "Unnumbered": **Official Rulebook Excerpt (p.[Page]):** "[Exact verbatim quote from the source excerpt]"
  Do NOT print the word "Unnumbered" in the citation under any circumstances.

CRITICAL rules for The Book citation:
- Default to concise answers. The Ruling should usually be 2-4 sentences. Do not list every exception, penalty, or sub-rule unless the user specifically asks for details, penalties, exceptions, or the full rule.
- For broad existence questions like "is there a slide rule" or "is there a uniform rule", answer the direct question first and cite the controlling rule. Mention that more detail exists only if needed.
- The Book should usually include 1 citation. Include a second citation only when it directly answers a distinct part of the user's question. Do not cite every supporting sentence.
- Use the rule number exactly as it appears in the excerpt label (e.g. "505", "4.01"). If no number is present, use the "Official Rulebook Excerpt" format above.
- The quoted text MUST be copied character-for-character from the source excerpt — do not paraphrase, summarise, rearrange words, or change punctuation. The downstream verifier checks this quote byte-for-byte against the original source.
- If the answer draws on multiple rules, provide one citation line per rule in the same format.
- Every factual rule requirement mentioned in The Ruling must be supported by at least one citation in The Book, but do not expand the answer just because more source text was retrieved.
- Never add words or ellipses inside the quote that are not in the original.

Answer:`;
}

// ── Verified Answer Cache ─────────────────────────────────────────────────────
//
// Cache layer for answers that have already been verified by the verifier LLM.
// Only answers with verifier_status = 'approved' are ever written here.
// The cache is scoped by (league_slug, rulebook_version_id, normalized_question),
// so activating a new rulebook version automatically invalidates old entries.

/**
 * Normalize a question for use as a cache key.
 * Lowercases, strips basic punctuation, collapses whitespace.
 * "Must slide?" and "must slide" → "must slide"
 * Exported for testing.
 *
 * @param {string} q
 * @returns {string}
 */
export function normalizeQuestion(q) {
  if (!q || typeof q !== 'string') return '';
  return q
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]{}/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look up a verified answer in the cache.
 * Returns the DB row on a hit, null on a miss or error.
 *
 * @param {pg.PoolClient} dbClient
 * @param {string} leagueSlug
 * @param {string} activeVersionId
 * @param {string} normalizedQ
 * @returns {Promise<Object|null>}
 */
async function readAnswerCache(dbClient, leagueSlug, activeVersionId, normalizedQ) {
  try {
    const res = await dbClient.query(`
      SELECT id, answer, cited_source_ids, cited_rule_numbers, verifier_status
      FROM   verified_answer_cache
      WHERE  league_slug         = $1
        AND  rulebook_version_id = $2
        AND  normalized_question = $3
      LIMIT  1
    `, [leagueSlug, activeVersionId, normalizedQ]);
    return res.rows[0] ?? null;
  } catch (err) {
    console.warn('[ask-v2] Cache read failed (skipping):', err.message);
    return null;
  }
}

/**
 * Non-blocking background update: increment hit_count and set last_used_at.
 * Errors are swallowed — cache stats are best-effort.
 *
 * @param {pg.Pool} dbPool
 * @param {string}  cacheId  UUID of the verified_answer_cache row.
 */
function bumpCacheHit(dbPool, cacheId) {
  dbPool.query(
    `UPDATE verified_answer_cache
     SET hit_count = hit_count + 1, last_used_at = now()
     WHERE id = $1`,
    [cacheId],
  ).catch(err => console.warn('[ask-v2] Cache bump failed:', err.message));
}

/**
 * Non-blocking background write: UPSERT a verified answer into the cache.
 * Only called after verifier_status === 'approved'.
 * Errors are swallowed — cache writes are best-effort.
 *
 * @param {pg.Pool} dbPool
 * @param {Object}  entry
 */
function writeAnswerCache(dbPool, {
  leagueSlug, activeVersionId, normalizedQ,
  answer, citedSourceIds, citedRuleNumbers, verifierStatus,
}) {
  const draftModel  = process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6';
  const verifyModel = process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-opus-4-8';

  dbPool.query(`
    INSERT INTO verified_answer_cache
      (league_slug, rulebook_version_id, normalized_question,
       answer, cited_source_ids, cited_rule_numbers,
       verifier_status, draft_model, verify_model)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (league_slug, rulebook_version_id, normalized_question)
    DO UPDATE SET
      answer             = EXCLUDED.answer,
      cited_source_ids   = EXCLUDED.cited_source_ids,
      cited_rule_numbers = EXCLUDED.cited_rule_numbers,
      verifier_status    = EXCLUDED.verifier_status,
      draft_model        = EXCLUDED.draft_model,
      verify_model       = EXCLUDED.verify_model,
      last_used_at       = now()
  `, [
    leagueSlug, activeVersionId, normalizedQ,
    answer,
    citedSourceIds,
    citedRuleNumbers ?? [],
    verifierStatus,
    draftModel,
    verifyModel,
  ]).catch(err => console.warn('[ask-v2] Cache write failed:', err.message));
}

async function runRAG({ sanitizedQuestion, league, conversation, extraContext = '' }) {
  const { slug: leagueSlug } = resolveLeague(league);
  const normalizedQ = normalizeQuestion(sanitizedQuestion);

  if (!pool)      throw new Error('DATABASE_URL not configured');
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');

  const dbClient = await pool.connect();
  let leagueName, activeVersionId, spans, method;

  try {
    // ── Step 1: Resolve active version (throws on league-not-found / not-active) ──
    ({ leagueName, activeVersionId } = await resolveActiveVersion(dbClient, leagueSlug));

    // ── Step 1b: Cache read ───────────────────────────────────────────────────
    //   Only checked for non-contextual questions (no extraContext from an interview).
    //   Interview rulings depend on specific play details and must not be cached.
    if (!extraContext) {
      const hit = await readAnswerCache(dbClient, leagueSlug, activeVersionId, normalizedQ);
      if (hit) {
        bumpCacheHit(pool, hit.id);
        return {
          reply:                hit.answer,
          cached:               true,
          blocked:              false,
          verifierAudit:        { status: hit.verifier_status, claims: [], unsupported_claims: [], confidence: 'high' },
          usedFallback:         false,
          fallbackLeague:       null,
          leagueName,
          league_slug:          leagueSlug,
          active_version_id:    activeVersionId,
          retrieved_source_ids: hit.cited_source_ids ?? [],
          cited_rule_numbers:   hit.cited_rule_numbers ?? [],
          _debug: process.env.RULEBOOK_DEBUG === '1'
            ? { retrieval_method: 'cache', cache_id: hit.id }
            : undefined,
        };
      }
    }

    // ── Step 2: FTS retrieval — strictly version-scoped ──────────────────────
    ({ spans, method } = await fetchSourceSpans(dbClient, activeVersionId, sanitizedQuestion));
  } finally {
    try { dbClient.release(); } catch { /* ignore */ }
  }

  // ── Step 3: Build prompt from source spans ───────────────────────────────
  const prompt = buildSpanPrompt({
    spans,
    leagueName,
    sanitizedQuestion,
    extraContext,
    conversation,
  });

  const message = await anthropic.messages.create({
    model:      process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  const reply = message.content[0]?.text?.trim() || 'No answer received.';

  // ── Step 4: Verifier (blocking gate) ─────────────────────────────────────
  //
  // Every factual claim in the draft is checked against the retrieved source
  // spans.  The verifier is fail-closed — any error or ambiguity blocks the
  // draft from reaching the user.
  const verifierAudit = await runVerifier({ anthropicClient: anthropic, draftAnswer: reply, spans });
  const blocked       = isVerifierBlocked(verifierAudit);

  // ── Step 5: Cache write (non-blocking, approved only) ─────────────────────
  //   Only write if the verifier explicitly approved the answer AND this is not
  //   an interview ruling (interview rulings are play-context-specific).
  if (!blocked && verifierAudit.status === 'approved' && !extraContext) {
    const retrievedSourceIdsForCache = spans.map(s => s.source_id);
    const citedRuleNumbersForCache   = [
      ...new Set(
        spans.flatMap(s =>
          (s.rule_numbers ?? '').split(',').map(n => n.trim()).filter(Boolean),
        ),
      ),
    ];
    writeAnswerCache(pool, {
      leagueSlug:       leagueSlug,
      activeVersionId,
      normalizedQ,
      answer:           reply,
      citedSourceIds:   retrievedSourceIdsForCache,
      citedRuleNumbers: citedRuleNumbersForCache,
      verifierStatus:   verifierAudit.status,
    });
  }

  // ── Response metadata ────────────────────────────────────────────────────
  const retrievedSourceIds = spans.map(s => s.source_id);
  const citedRuleNumbers   = [
    ...new Set(
      spans.flatMap(s =>
        (s.rule_numbers ?? '').split(',').map(n => n.trim()).filter(Boolean),
      ),
    ),
  ];

  const debugData = process.env.RULEBOOK_DEBUG === '1' ? {
    retrieval_method: method,
    span_count:       spans.length,
    spans: spans.map(s => ({
      source_id:    s.source_id,
      rule_numbers: s.rule_numbers,
      page_start:   s.page_start,
      rank:         s.rank,
      text_preview: (s.exact_text ?? '').slice(0, 120),
    })),
    verifier_audit: verifierAudit,
  } : undefined;

  return {
    reply,
    cached:                false,
    blocked,
    verifierAudit,
    usedFallback:          false,
    fallbackLeague:        null,
    leagueName,
    // V3 retrieval metadata
    league_slug:           leagueSlug,
    active_version_id:     activeVersionId,
    retrieved_source_ids:  retrievedSourceIds,
    cited_rule_numbers:    citedRuleNumbers,
    _debug:                debugData,
  };
}

// ── DB Logging ───────────────────────────────────────────────────────────────

function logToDb({ sanitizedQuestion, reply, leagueName, usedFallback, fallbackLeague }) {
  if (!pool) return;
  (async () => {
    try {
      const ruleRef  = extractRuleRef(reply);
      const rulebook = usedFallback ? fallbackLeague : leagueName;
      await pool.query(
        'INSERT INTO question_logs (question, answer, rule_ref, rulebook, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [
          sanitizedQuestion,
          sanitizeInput(reply,    5000),
          sanitizeInput(ruleRef,  50),
          sanitizeInput(rulebook, 100),
        ],
      );
    } catch (err) {
      console.error('[ask-v2] Failed to log question/answer:', err.message);
    }
  })();
}

// ── Main Handler ─────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Input validation ──────────────────────────────────────────────────

  const { question, league, conversation, matrix_state: rawMatrixState } = req.body ?? {};

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required and must be a string' });
  }

  const sanitizedQuestion = sanitizeInput(question, 1000);
  if (sanitizedQuestion.length < 3) {
    return res.status(400).json({ error: 'question must be at least 3 characters' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing Anthropic API key' });
  }

  // ── 2. Validate matrix_state (if provided) ───────────────────────────────

  const matrixState = validateMatrixState(rawMatrixState);

  try {

    // ── 3. Ongoing interview: matrix_state was provided ────────────────────
    //
    //   The client is continuing an interview that was started on a previous
    //   request. Either advance to the next question (State B) or, if all
    //   questions are answered, synthesize a ruling (State C).

    if (matrixState) {
      const matrix = findMatrix(matrixState.matrix_id);

      if (!matrix) {
        // Unknown matrix — fall through to standard RAG rather than erroring
        console.warn(`[ask-v2] Unknown matrix_id "${matrixState.matrix_id}", falling back to RAG`);
      } else {
        const nextQuestion = getNextQuestion(matrix, matrixState.answers);

        if (nextQuestion) {
          // ── State B: more questions needed ──────────────────────────────
          const answeredCount   = Object.keys(matrixState.answers).length;
          const totalApplicable = matrix.questions.filter(q => {
            if (q.depends_on === null) return true;
            return Object.entries(q.depends_on).every(
              ([depId, depVal]) => (matrixState.answers[depId] ?? '').toLowerCase() === depVal.toLowerCase(),
            );
          }).length;

          return res.status(200).json({
            state:            'needs_clarification',
            matrix_id:        matrix.id,
            matrix_label:     matrix.label,
            current_question: {
              id:      nextQuestion.id,
              text:    nextQuestion.text,
              type:    nextQuestion.type,
              options: nextQuestion.options,
            },
            progress: {
              answered:            answeredCount,
              remaining_estimated: Math.max(0, totalApplicable - answeredCount),
            },
          });
        }

        // ── State C: all answers collected → run RAG with context ────────
        const extraContext = buildRulingContext(matrix, matrixState.answers);
        const ragResult = await runRAG({
          sanitizedQuestion,
          league,
          conversation,
          extraContext,
        });
        const { reply, cached, blocked, verifierAudit, usedFallback, fallbackLeague, leagueName,
                league_slug, active_version_id, retrieved_source_ids,
                cited_rule_numbers, _debug } = ragResult;

        // ── Verifier gate (fail-closed) ───────────────────────────────────
        if (blocked) {
          return res.status(200).json({
            state:            'unverifiable',
            error:            'unverifiable',
            message:          'I cannot verify this answer from the loaded rulebook. Please rephrase or consult the official rulebook directly.',
            league_slug,
            active_version_id,
            ...(process.env.RULEBOOK_DEBUG === '1' ? { verifier_audit: verifierAudit } : {}),
          });
        }

        logToDb({ sanitizedQuestion, reply, leagueName, usedFallback, fallbackLeague });

        return res.status(200).json({
          state:                'ruling',
          matrix_id:            matrix.id,
          answers_used:         matrixState.answers,
          reply,
          cached,
          usedFallback,
          fallbackLeague,
          originalLeague:       leagueName,
          // V3 retrieval metadata
          league_slug,
          active_version_id,
          retrieved_source_ids,
          cited_rule_numbers,
          verifier_status:      verifierAudit.status,
          ...(_debug ? { _debug } : {}),
        });
      }
    }

    // ── 4. New question: route via pre-screen + classifier ─────────────────
    //
    //   Step 1: Keyword pre-screen (zero latency, no API call).
    //           If no keyword match → question is almost certainly factual →
    //           skip classifier and go straight to RAG (State A).
    //
    //   Step 2: If keyword match → call Claude Haiku to confirm and to identify
    //           the precise Judgment Matrix.
    //
    //   Step 3: If classifier confirms judgment AND confidence is high enough →
    //           return the first interview question (State B).
    //
    //   Step 4: Otherwise (factual, low confidence, or classifier error) →
    //           run RAG and return the answer (State A).

    // ── Two-tier routing ────────────────────────────────────────────────────
    //
    // Tier 1 — keyword prescreen (0ms, no API call).
    //   Specific trigger phrases are reliable: trust a hit directly.
    //
    // Tier 2 — LLM classifier (only when prescreen misses).
    //   Catches judgment calls described in natural language without obvious
    //   keywords (e.g. "the infielder was standing in front of the base" before
    //   "blocking" was added to the triggers). The classifier was originally
    //   removed because it overrode correct prescreen hits; here it only runs
    //   when the prescreen returned nothing, so that conflict cannot occur.
    const prescreenMatch = prescreenForMatrix(sanitizedQuestion);
    let   targetMatrix   = prescreenMatch ?? null;

    if (!targetMatrix) {
      const classification = await classifyQuestion(sanitizedQuestion);
      if (
        classification?.classification === 'judgment' &&
        classification?.confidence >= CLASSIFIER_CONFIDENCE_THRESHOLD &&
        classification?.matrix_id
      ) {
        targetMatrix = findMatrix(classification.matrix_id);
      }
    }

    if (targetMatrix) {
      // ── State B: judgment call detected — start interview ────────────────
      const firstQuestion = getNextQuestion(targetMatrix, {});

      if (firstQuestion) {
        const totalQuestions = targetMatrix.questions.filter(q => q.depends_on === null).length;

        return res.status(200).json({
          state:            'needs_clarification',
          matrix_id:        targetMatrix.id,
          matrix_label:     targetMatrix.label,
          current_question: {
            id:      firstQuestion.id,
            text:    firstQuestion.text,
            type:    firstQuestion.type,
            options: firstQuestion.options,
          },
          progress: {
            answered:            0,
            remaining_estimated: totalQuestions,
          },
        });
      }
    }

    // ── State A: factual question (or classifier fell through) ────────────
    const ragResult = await runRAG({
      sanitizedQuestion,
      league,
      conversation,
    });
    const { reply, cached, blocked, verifierAudit, usedFallback, fallbackLeague, leagueName,
            league_slug, active_version_id, retrieved_source_ids,
            cited_rule_numbers, _debug } = ragResult;

    // ── Verifier gate (fail-closed) ──────────────────────────────────────
    if (blocked) {
      return res.status(200).json({
        state:            'unverifiable',
        error:            'unverifiable',
        message:          'I cannot verify this answer from the loaded rulebook. Please rephrase or consult the official rulebook directly.',
        league_slug,
        active_version_id,
        ...(process.env.RULEBOOK_DEBUG === '1' ? { verifier_audit: verifierAudit } : {}),
      });
    }

    logToDb({ sanitizedQuestion, reply, leagueName, usedFallback, fallbackLeague });

    return res.status(200).json({
      state:                'answered',
      reply,
      cached,
      usedFallback,
      fallbackLeague,
      originalLeague:       leagueName,
      // V3 retrieval metadata
      league_slug,
      active_version_id,
      retrieved_source_ids,
      cited_rule_numbers,
      verifier_status:      verifierAudit.status,
      ...(_debug ? { _debug } : {}),
    });

  } catch (err) {
    if (err.type === 'league_not_found') {
      return res.status(404).json({ error: 'league_not_found', message: err.message });
    }
    if (err.type === 'rulebook_not_active') {
      return res.status(404).json({ error: 'rulebook_not_active', message: err.message });
    }
    console.error('[ask-v2] ERROR:', err.message);
    console.error('[ask-v2] Stack:', err.stack);
    return res.status(500).json({ error: 'Something went wrong processing the rules.' });
  }
};

export default withCors(handler);
