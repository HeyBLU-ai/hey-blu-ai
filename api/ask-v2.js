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
 *   force_rag    {boolean} — when true, skip judgment-matrix routing and run standard RAG
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
import { randomUUID } from 'node:crypto';
import pg             from 'pg';
import {
  JUDGMENT_MATRICES,
  findMatrix,
  getNextQuestion,
  buildRulingContext,
  prescreenForMatrix,
  questionHasDetailedPlayContext,
} from './judgment-matrices.js';
import { citationLabelFor, getLeagueMetadata } from '../lib/league-metadata.js';

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

// ── League Mapping ───────────────────────────────────────────────────────────

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

export function leagueInputToSlug(league) {
  try {
    return resolveLeague(league).slug;
  } catch {
    return '';
  }
}

export function validateConversation(conversation, currentLeagueSlug = '') {
  if (!conversation || !Array.isArray(conversation)) return [];
  const leagueNorm = leagueInputToSlug(currentLeagueSlug);
  return conversation
    .slice(0, 10)
    .map(turn => {
      if (!turn || typeof turn !== 'object') return null;
      const turnSlug = leagueInputToSlug(turn.league ?? '');
      // Require each turn to match the current league; drop cross-league or untagged legacy turns.
      if (leagueNorm && turnSlug !== leagueNorm) return null;
      return {
        user: sanitizeInput(turn.user, 1000),
        ai: sanitizeInput(turn.ai, 2000),
      };
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

// ── Anthropic client ─────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { runVerifier, isVerifierBlocked } from './verifier.js';
import {
  fetchEvidenceBundlesWithFallback,
  formatEvidenceBundlesForPrompt,
  vectorLiteral,
  DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
} from '../lib/ingest/evidence-bundle.js';
import { LLM_ANSWER_MODEL, LLM_FAST_MODEL, LLM_VERIFY_MODEL } from '../lib/llm-models.js';

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const ANSWER_TIMEOUT_MS = Number(process.env.ANTHROPIC_ANSWER_TIMEOUT_MS ?? 22000);
// 20s (was 12s): a slow-but-valid verifier pass was being killed at 12s and
// fail-closed into an "I cannot verify" non-answer. This stays well within the
// client's 45s fetch timeout and the function's 60s max duration.
const VERIFY_TIMEOUT_MS = Number(process.env.ANTHROPIC_VERIFY_TIMEOUT_MS ?? 20000);

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

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
- tag_secure_possession    : Tag play where the ball is dislodged, bobbled, or re-caught — was possession secure when the tag was applied?
- appeal_play              : Post-play APPEAL procedure only (missed base, left early, failed tag-up, batting out of turn) — NOT live tag bobbles
- force_vs_tag             : Whether a force play or a tag is required on a specific play

IMPORTANT DISTINCTIONS:
- tag_secure_possession vs appeal_play: A fielder tagging a runner and losing the ball mid-play is tag_secure_possession, NOT appeal_play.
- appeal_play is ONLY when the defense appeals an infraction after the play (missed base, tag-up, etc.).
- If the question already describes the full sequence of events (who had the ball, when it was dislodged, who reached the base first), classify as FACTUAL so the rulebook can answer directly.

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
      model:      LLM_FAST_MODEL,
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
//   2. fetchEvidenceBundleResults — hybrid search on rule_node_chunks,
//      assemble hierarchical Evidence Bundles for the drafter and verifier.
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

const EVIDENCE_FALLBACK_SCORE_THRESHOLD = Number(
  process.env.EVIDENCE_FALLBACK_SCORE_THRESHOLD ?? DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
);

/**
 * Looks up the league row and its single ACTIVE rulebook_version.
 *
 * @param {pg.PoolClient} dbClient
 * @param {string}        leagueSlug
 * @returns {{
 *   leagueId: string,
 *   leagueName: string,
 *   activeVersionId: string,
 *   fallbackLeagueId: string|null,
 *   fallbackLeagueSlug: string|null,
 *   fallbackLeagueName: string|null,
 *   fallbackActiveVersionId: string|null,
 * }}
 * @throws {LeagueNotFoundError}   if no leagues row with that slug exists.
 * @throws {RulebookNotActiveError} if the league exists but has no active version.
 */
async function resolveActiveVersion(dbClient, leagueSlug) {
  const res = await dbClient.query(`
    SELECT l.id              AS league_id,
           l.name            AS league_name,
           l.fallback_league_id,
           rv.id             AS version_id,
           fb.slug           AS fallback_slug,
           fb.name           AS fallback_name,
           fb_rv.id          AS fallback_version_id
    FROM   leagues l
    LEFT   JOIN rulebook_versions rv
             ON rv.league_id = l.id AND rv.status = 'active'
    LEFT   JOIN leagues fb
             ON fb.id = l.fallback_league_id
    LEFT   JOIN rulebook_versions fb_rv
             ON fb_rv.league_id = fb.id AND fb_rv.status = 'active'
    WHERE  l.slug = $1
  `, [leagueSlug]);

  if (res.rows.length === 0) {
    throw new LeagueNotFoundError(
      `No rulebook is loaded for league "${leagueSlug}". ` +
      `Select a different league or contact an admin.`,
    );
  }

  const {
    league_id,
    league_name,
    version_id,
    fallback_league_id,
    fallback_slug,
    fallback_name,
    fallback_version_id,
  } = res.rows[0];

  if (!version_id) {
    throw new RulebookNotActiveError(
      `No active rulebook is loaded for "${league_name}". ` +
      `An admin must activate a rulebook version before questions can be answered.`,
    );
  }

  return {
    leagueId:                league_id,
    leagueName:              league_name,
    activeVersionId:         version_id,
    fallbackLeagueId:        fallback_league_id ?? null,
    fallbackLeagueSlug:      fallback_slug ?? null,
    fallbackLeagueName:      fallback_name ?? null,
    fallbackActiveVersionId: fallback_version_id ?? null,
  };
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
    console.warn('[ask-v2] Question embedding failed — using lexical evidence retrieval:', err.message);
    return null;
  }
}

/**
 * Hybrid retrieval over rule_node_chunks → hierarchical Evidence Bundles.
 *
 * @param {pg.PoolClient} dbClient
 * @param {string}        activeVersionId
 * @param {string}        question
 * @returns {Promise<{ bundles: Object[], method: string }>}
 */
async function fetchEvidenceBundleResults(dbClient, activeVersionId, question, fallbackVersionId = null, precomputedEmbedding = undefined) {
  const queryEmbedding = precomputedEmbedding !== undefined
    ? precomputedEmbedding
    : await embedQuestion(question);
  const result = await fetchEvidenceBundlesWithFallback(
    dbClient,
    activeVersionId,
    question,
    {
      queryEmbedding,
      fallbackVersionId,
      scoreThreshold: EVIDENCE_FALLBACK_SCORE_THRESHOLD,
    },
  );
  return result;
}

/**
 * Build the Claude prompt from hierarchical Evidence Bundles.
 */
function buildDisclaimerMeta({
  leagueSlug,
  leagueName,
  fallbackLeagueSlug = null,
  fallbackLeagueName = null,
  usedFallback = false,
}) {
  const primaryMeta = getLeagueMetadata(leagueSlug);
  const fallbackMeta = usedFallback ? getLeagueMetadata(fallbackLeagueSlug) : null;

  return {
    league_display_name:          leagueName,
    league_website_url:           primaryMeta.websiteUrl,
    league_link_text:             primaryMeta.linkText ?? leagueName,
    fallback_league_display_name: usedFallback ? fallbackLeagueName : null,
    fallback_league_website_url:  usedFallback ? (fallbackMeta?.websiteUrl ?? null) : null,
    fallback_league_link_text:    usedFallback
      ? (fallbackMeta?.linkText ?? fallbackLeagueName)
      : null,
  };
}

function buildEvidencePrompt({
  bundles,
  leagueName,
  sanitizedQuestion,
  extraContext,
  conversation,
  leagueSlug,
  usedFallback = false,
  fallbackLeagueName = null,
  fallbackLeagueSlug = null,
}) {
  const validatedConversation = validateConversation(conversation, leagueSlug);
  const historyText = validatedConversation.length > 0
    ? 'Prior conversation:\n' +
      validatedConversation.map(t => `Umpire: ${t.user}\nOfficial: ${t.ai}`).join('\n\n') + '\n\n'
    : '';

  const bundleBlock = formatEvidenceBundlesForPrompt(bundles);

  const fallbackCitationLabel = usedFallback
    ? citationLabelFor(fallbackLeagueSlug, fallbackLeagueName)
    : citationLabelFor(leagueSlug, leagueName);

  const fallbackNote = usedFallback && fallbackLeagueName
    ? `The question concerns ${leagueName} play. Local ${leagueName} rulebook retrieval did not surface sufficiently strong evidence, so the Evidence Bundles below are from the governing ${fallbackLeagueName} rulebook configured as this league's fallback authority.\n\n`
    : '';

  const noRuleMessage = usedFallback && fallbackLeagueName
    ? `I could not find an applicable rule for that question in the ${leagueName} or ${fallbackLeagueName} rulebooks.`
    : `I could not find an applicable rule for that question in the ${leagueName} rulebook.`;

  const citationFormatBlock = usedFallback
    ? `- Because the Evidence Bundles are from the fallback rulebook (${fallbackLeagueName}), every citation in **The Book** MUST use this prefix: **${fallbackCitationLabel} Official Rule [Number] (p.[Page]):** "[quote]". Never write "Official Rule [Number]" without the "${fallbackCitationLabel}" prefix.\n`
    : `- If the bundle has a clear rule number (e.g. "305", "505"): **${fallbackCitationLabel} Official Rule [Number] (p.[Page]):** "[Exact verbatim quote from the canonical text]"\n- If the bundle has no rule number: **${fallbackCitationLabel} Official Rulebook Excerpt (p.[Page]):** "[Exact verbatim quote from the canonical text]"\n`;

  return `You are an expert baseball rules official for the ${leagueName}.

Assume questions are about live game play unless explicitly about league administration.

Your job: answer the umpire's question using ONLY the Evidence Bundles shown below. Each bundle contains a rule node's canonical text, its ancestor heading path, and any attached comments, exceptions, or penalties.

${fallbackNote}${extraContext ? `PLAY CONTEXT:\n${extraContext}\n\n` : ''}\
${historyText}\
EVIDENCE BUNDLES (${bundles.length} retrieved):
${bundleBlock}

QUESTION: ${sanitizedQuestion}

Instructions:
- Answer ONLY from the Evidence Bundles above. Do NOT cite, invent, or infer rules that do not appear in the bundles.
- If no bundle covers the question, respond with exactly: "${noRuleMessage}"
- Never mention retrieval internals or bundle availability. Forbidden phrases include: "excerpts I have access to", "retrieved portions", "loaded rulebook", "based on what was provided", "I only have", and "the bundles show".
- Do NOT include any disclaimer, fallback notice, legal notice, or "visit official rulebook" text. The application renders disclaimers separately.
- Otherwise, structure your response in EXACTLY these two parts, in this order, with these exact headings:

**The Ruling:** Write a conversational, plain-English explanation that an umpire can understand and act on immediately. You may paraphrase lightly here to make the rule clear, but every factual claim must be grounded in the canonical text.

**The Book:** On a new line after The Ruling, provide the official citation(s) using these exact formats:

${citationFormatBlock}
CRITICAL rules for The Book citation:
- Default to concise answers. The Ruling should usually be 2-4 sentences. Do not list every exception, penalty, or sub-rule unless the user specifically asks for details, penalties, exceptions, or the full rule.
- For broad existence questions like "is there a slide rule" or "is there a uniform rule", answer the direct question first and cite the controlling rule. Mention that more detail exists only if needed.
- The Book should usually include 1 citation. Include a second citation only when it directly answers a distinct part of the user's question.
- Use the rule number exactly as it appears in the bundle. The quoted text MUST be copied character-for-character from the canonical text.
- Every factual rule requirement mentioned in The Ruling must be supported by at least one citation in The Book.
- Never add words or ellipses inside the quote that are not in the original.

Answer:`;
}

// ── Verified Answer Cache ─────────────────────────────────────────────────────
//
// Cache layer for answers that have already been verified by the verifier LLM.
// Only answers with verifier_status = 'approved' are ever written or read here.
// Negative outcomes (no_rule_found, unsupported, needs_fact, etc.) are never
// cached — stale failure rows must not poison future lookups.
//
// Cache key: (league_slug, rulebook_version_id, prompt_version, normalized_question).
// rulebook_version_id is the active rulebook version; prompt_version invalidates
// entries when the answer or verifier prompt changes.

/** Bump when answer/verifier prompts change to invalidate stale cache rows. */
export const ANSWER_PROMPT_VERSION = process.env.ANSWER_PROMPT_VERSION ?? '2026-06-15-in-game-assumption';

const CACHEABLE_VERIFIER_STATUSES = new Set(['approved']);

/**
 * Whether a verifier outcome may be persisted in verified_answer_cache.
 * Exported for tests.
 *
 * @param {{ verifierStatus: string, extraContext?: string }} opts
 * @returns {boolean}
 */
export function canWriteToAnswerCache({ verifierStatus, extraContext = '' }) {
  if (extraContext) return false;
  return CACHEABLE_VERIFIER_STATUSES.has(verifierStatus);
}

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
        AND  prompt_version      = $3
        AND  normalized_question = $4
        AND  verifier_status     = 'approved'
      LIMIT  1
    `, [leagueSlug, activeVersionId, ANSWER_PROMPT_VERSION, normalizedQ]);
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
  extraContext = '',
}) {
  if (!canWriteToAnswerCache({ verifierStatus, extraContext })) return;

  const draftModel  = LLM_ANSWER_MODEL;
  const verifyModel = LLM_VERIFY_MODEL;

  dbPool.query(`
    INSERT INTO verified_answer_cache
      (league_slug, rulebook_version_id, prompt_version, normalized_question,
       answer, cited_source_ids, cited_rule_numbers,
       verifier_status, draft_model, verify_model)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (league_slug, rulebook_version_id, prompt_version, normalized_question)
    DO UPDATE SET
      answer             = EXCLUDED.answer,
      cited_source_ids   = EXCLUDED.cited_source_ids,
      cited_rule_numbers = EXCLUDED.cited_rule_numbers,
      verifier_status    = EXCLUDED.verifier_status,
      draft_model        = EXCLUDED.draft_model,
      verify_model       = EXCLUDED.verify_model,
      last_used_at       = now()
  `, [
    leagueSlug, activeVersionId, ANSWER_PROMPT_VERSION, normalizedQ,
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

  // Kick off the question embedding immediately so its network round-trip
  // overlaps the DB version lookup + cache read below (~200-400ms saved on the
  // uncached path). embedQuestion swallows its own errors and resolves to null,
  // so a stray rejection can never crash the request. On a cache hit we simply
  // never await it.
  const embeddingPromise = embedQuestion(sanitizedQuestion);

  const dbClient = await pool.connect();
  let leagueName, activeVersionId, bundles, method;
  let usedFallback = false;
  let fallbackLeagueName = null;
  let fallbackLeagueSlug = null;
  let fallbackActiveVersionId = null;
  let primaryBestScore = null;
  let fallbackBestScore = null;
  let scoreThreshold = null;
  let primaryMethod = null;
  let retrievalMeta = {};

  try {
    // ── Step 1: Resolve active version (throws on league-not-found / not-active) ──
    ({
      leagueName,
      activeVersionId,
      fallbackLeagueName,
      fallbackLeagueSlug,
      fallbackActiveVersionId,
    } = await resolveActiveVersion(dbClient, leagueSlug));

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
          ...buildDisclaimerMeta({ leagueSlug, leagueName }),
          _debug: process.env.RULEBOOK_DEBUG === '1'
            ? { retrieval_method: 'cache', cache_id: hit.id }
            : undefined,
        };
      }
    }

    // ── Step 2: Hybrid evidence bundle retrieval — version-scoped with fallback ─
    const queryEmbedding = await embeddingPromise;
    const retrieval = await fetchEvidenceBundleResults(
      dbClient,
      activeVersionId,
      sanitizedQuestion,
      fallbackActiveVersionId,
      queryEmbedding,
    );
    ({
      bundles,
      method,
      usedFallback,
      primaryBestScore,
      fallbackBestScore,
      scoreThreshold,
      primaryMethod,
    } = retrieval);
    retrievalMeta = {
      primaryBestScore,
      fallbackBestScore,
      scoreThreshold,
      primaryMethod,
      fallbackVersionId: usedFallback ? fallbackActiveVersionId : null,
    };
  } finally {
    try { dbClient.release(); } catch { /* ignore */ }
  }

  // ── Step 3: Build prompt from Evidence Bundles ───────────────────────────
  const prompt = buildEvidencePrompt({
    bundles,
    leagueName,
    sanitizedQuestion,
    extraContext,
    conversation,
    leagueSlug,
    usedFallback,
    fallbackLeagueName,
    fallbackLeagueSlug,
  });

  const message = await withTimeout(
    anthropic.messages.create({
      model:      LLM_ANSWER_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    }),
    ANSWER_TIMEOUT_MS,
    'Answer generation',
  );

  const reply = message.content[0]?.text?.trim() || 'No answer received.';

  // ── Step 4: Verifier (blocking gate) ─────────────────────────────────────
  //
  // Every factual claim in the draft is checked against the retrieved source
  // spans.  The verifier is fail-closed — any error or ambiguity blocks the
  // draft from reaching the user.
  let verifierAudit;
  try {
    verifierAudit = await withTimeout(
      runVerifier({ anthropicClient: anthropic, draftAnswer: reply, bundles }),
      VERIFY_TIMEOUT_MS,
      'Answer verification',
    );
  } catch (err) {
    console.warn('[ask-v2] Verifier timed out (fail-closed):', err.message);
    verifierAudit = {
      status:             'unsupported',
      claims:             [],
      unsupported_claims: ['verifier_timeout: ' + err.message.slice(0, 120)],
      confidence:         'low',
      _error:             'timeout',
    };
  }
  const blocked = isVerifierBlocked(verifierAudit);

  // ── Step 5: Cache write (non-blocking, approved only) ─────────────────────
  //   Only write if the verifier explicitly approved the answer AND this is not
  //   an interview ruling (interview rulings are play-context-specific).
  if (canWriteToAnswerCache({ verifierStatus: verifierAudit.status, extraContext }) && !usedFallback) {
    const retrievedSourceIdsForCache = bundles.map(b => b.bundle_id);
    const citedRuleNumbersForCache   = [
      ...new Set(bundles.map(b => b.rule_number).filter(Boolean)),
    ];
    writeAnswerCache(pool, {
      leagueSlug:       leagueSlug,
      activeVersionId,
      normalizedQ,
      answer:           reply,
      citedSourceIds:   retrievedSourceIdsForCache,
      citedRuleNumbers: citedRuleNumbersForCache,
      verifierStatus:   verifierAudit.status,
      extraContext,
    });
  }

  // ── Response metadata ────────────────────────────────────────────────────
  const retrievedSourceIds = bundles.map(b => b.bundle_id);
  const citedRuleNumbers   = [
    ...new Set(bundles.map(b => b.rule_number).filter(Boolean)),
  ];

  const debugData = process.env.RULEBOOK_DEBUG === '1' ? {
    retrieval_method: method,
    bundle_count:     bundles.length,
    used_fallback:    usedFallback,
    ...retrievalMeta,
    bundles: bundles.map(b => ({
      bundle_id:       b.bundle_id,
      rule_number:     b.rule_number,
      ancestor_path:   b.ancestor_path,
      page_start:      b.page_start,
      hybrid_score:    b.hybrid_score,
      rulebook_source: b.rulebook_source,
      text_preview:    (b.canonical_text ?? '').slice(0, 120),
    })),
    verifier_audit: verifierAudit,
  } : undefined;

  return {
    reply,
    cached:                false,
    blocked,
    verifierAudit,
    usedFallback,
    fallbackLeague:        usedFallback ? fallbackLeagueName : null,
    fallback_version_id:   usedFallback ? fallbackActiveVersionId : null,
    leagueName,
    // V3 retrieval metadata
    league_slug:           leagueSlug,
    active_version_id:     activeVersionId,
    fallbackLeagueSlug,
    retrieved_source_ids:  retrievedSourceIds,
    cited_rule_numbers:    citedRuleNumbers,
    ...buildDisclaimerMeta({
      leagueSlug,
      leagueName,
      fallbackLeagueSlug,
      fallbackLeagueName,
      usedFallback,
    }),
    _debug:                debugData,
  };
}

// ── DB Logging & Answer Events ───────────────────────────────────────────────

/**
 * Fire-and-forget insert of an answer event.
 *
 * The row id is generated by the caller (randomUUID) and returned synchronously,
 * so the HTTP response no longer waits on this DB round-trip. Errors are logged
 * and swallowed: the answer has already been delivered, and a missing event row
 * only means feedback for that one answer is a no-op (the client tolerates it).
 *
 * @param {{ id: string } & Record<string, unknown>} entry
 */
function persistAnswerEvent({
  id,
  league_slug,
  fallback_league_slug,
  sanitizedQuestion,
  reply,
  state,
  usedFallback,
  active_version_id,
  fallback_version_id,
  retrieved_source_ids,
  cited_rule_numbers,
  matrix_id,
  cached,
}) {
  if (!pool) return;

  const sourceIds = Array.isArray(retrieved_source_ids)
    ? retrieved_source_ids.filter(Boolean)
    : [];
  const ruleNumbers = Array.isArray(cited_rule_numbers)
    ? cited_rule_numbers.map(String).filter(Boolean).slice(0, 20)
    : [];

  pool.query(
    `INSERT INTO answer_events (
       id, league_slug, fallback_league_slug, question, answer, state,
       used_fallback, active_version_id, fallback_version_id,
       retrieved_source_ids, cited_rule_numbers, matrix_id, cached
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::text[], $12, $13)`,
    [
      id,
      league_slug,
      fallback_league_slug ?? null,
      sanitizedQuestion,
      sanitizeInput(reply, 8000),
      state,
      Boolean(usedFallback),
      active_version_id ?? null,
      fallback_version_id ?? null,
      sourceIds,
      ruleNumbers,
      matrix_id ?? null,
      Boolean(cached),
    ],
  ).catch(err => console.error('[ask-v2] answer_event persist failed (non-fatal):', err.message));
}

/**
 * User-facing message for a verifier-blocked answer.
 *
 * With RULEBOOK_DEBUG=1 it appends a one-line diagnostic (verifier status,
 * whether it errored/timed out, how many evidence bundles were retrieved, the
 * best match score, and the cited rule numbers) so a block can be diagnosed
 * straight from the screen — no dev tools required. The suffix only appears
 * when the debug flag is on, so it is safe to leave in place.
 */
function buildUnverifiableMessage(verifierAudit, { _debug = null, cited_rule_numbers = [] } = {}) {
  const base = 'I cannot verify this answer from the loaded rulebook. Please rephrase or consult the official rulebook directly.';
  if (process.env.RULEBOOK_DEBUG !== '1') return base;
  const status  = verifierAudit?.status ?? '?';
  const err     = verifierAudit?._error ? ` (${verifierAudit._error})` : '';
  const bundles = _debug?.bundle_count ?? '?';
  const score   = _debug?.primaryBestScore ?? '?';
  const rules   = (cited_rule_numbers ?? []).join(', ') || 'none';
  return `${base}\n\n[debug] verifier=${status}${err} | bundles=${bundles} | bestScore=${score} | rules=${rules}`;
}

/**
 * When RULEBOOK_DEBUG=1, append a one-line diagnostic to a successful answer so
 * retrieval behavior (did we fall back? how well did the primary rulebook
 * match?) is visible straight from the screen. No-op unless the flag is on.
 */
function buildAnswerDebug(reply, { usedFallback = false, _debug = null, verifierAudit = null, cited_rule_numbers = [] } = {}) {
  if (process.env.RULEBOOK_DEBUG !== '1') return reply;
  const parts = [
    `fallback=${usedFallback ? 'YES→' + (_debug?.fallbackVersionId ? 'fallback book' : '?') : 'no'}`,
    `verifier=${verifierAudit?.status ?? '?'}`,
    `bundles=${_debug?.bundle_count ?? '?'}`,
    `primaryScore=${_debug?.primaryBestScore ?? '?'}`,
    `fallbackScore=${_debug?.fallbackBestScore ?? '?'}`,
    `threshold=${_debug?.scoreThreshold ?? '?'}`,
    `rules=${(cited_rule_numbers ?? []).join(', ') || 'none'}`,
  ];
  return `${reply}\n\n[debug] ${parts.join(' | ')}`;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Input validation ──────────────────────────────────────────────────

  const { question, league, conversation, matrix_state: rawMatrixState, force_rag: forceRag } = req.body ?? {};
  const skipMatrixRouter = forceRag === true;

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

    if (matrixState && !skipMatrixRouter) {
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
                league_slug, active_version_id, fallback_version_id, retrieved_source_ids,
                cited_rule_numbers, _debug, fallbackLeagueSlug,
                league_display_name, league_website_url, league_link_text,
                fallback_league_display_name, fallback_league_website_url, fallback_league_link_text } = ragResult;

        // ── Verifier gate (fail-closed) ───────────────────────────────────
        if (blocked) {
          return res.status(200).json({
            state:            'unverifiable',
            error:            'unverifiable',
            message:          buildUnverifiableMessage(verifierAudit, { _debug, cited_rule_numbers }),
            league_slug,
            active_version_id,
            ...(process.env.RULEBOOK_DEBUG === '1' ? { verifier_audit: verifierAudit } : {}),
          });
        }

        const answer_event_id = randomUUID();
        persistAnswerEvent({
          id: answer_event_id,
          league_slug,
          fallback_league_slug: usedFallback ? fallbackLeagueSlug : null,
          sanitizedQuestion,
          reply,
          state: 'ruling',
          usedFallback,
          active_version_id,
          fallback_version_id,
          retrieved_source_ids,
          cited_rule_numbers,
          matrix_id: matrix.id,
          cached,
        });

        return res.status(200).json({
          state:                'ruling',
          matrix_id:            matrix.id,
          answers_used:         matrixState.answers,
          reply:                buildAnswerDebug(reply, { usedFallback, _debug, verifierAudit, cited_rule_numbers }),
          cached,
          usedFallback,
          fallbackLeague,
          originalLeague:       leagueName,
          answer_event_id,
          // V3 retrieval metadata
          league_slug,
          active_version_id,
          fallback_version_id,
          retrieved_source_ids,
          cited_rule_numbers,
          verifier_status:      verifierAudit.status,
          league_display_name,
          league_website_url,
          league_link_text,
          fallback_league_display_name,
          fallback_league_website_url,
          fallback_league_link_text,
          ...(_debug ? { _debug } : {}),
        });
      }
    }

    if (!skipMatrixRouter && !questionHasDetailedPlayContext(sanitizedQuestion)) {
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
    }

    // ── State A: factual question (or classifier fell through, or force_rag) ─
    const ragResult = await runRAG({
      sanitizedQuestion,
      league,
      conversation,
    });
    const { reply, cached, blocked, verifierAudit, usedFallback, fallbackLeague, leagueName,
            league_slug, active_version_id, fallback_version_id, retrieved_source_ids,
            cited_rule_numbers, _debug, fallbackLeagueSlug,
            league_display_name, league_website_url, league_link_text,
            fallback_league_display_name, fallback_league_website_url, fallback_league_link_text } = ragResult;

    // ── Verifier gate (fail-closed) ──────────────────────────────────────
    if (blocked) {
      return res.status(200).json({
        state:            'unverifiable',
        error:            'unverifiable',
        message:          buildUnverifiableMessage(verifierAudit, { _debug, cited_rule_numbers }),
        league_slug,
        active_version_id,
        ...(process.env.RULEBOOK_DEBUG === '1' ? { verifier_audit: verifierAudit } : {}),
      });
    }

    const answer_event_id = randomUUID();
    persistAnswerEvent({
      id: answer_event_id,
      league_slug,
      fallback_league_slug: usedFallback ? fallbackLeagueSlug : null,
      sanitizedQuestion,
      reply,
      state: 'answered',
      usedFallback,
      active_version_id,
      fallback_version_id,
      retrieved_source_ids,
      cited_rule_numbers,
      matrix_id: null,
      cached,
    });

    return res.status(200).json({
      state:                'answered',
      reply:                buildAnswerDebug(reply, { usedFallback, _debug, verifierAudit, cited_rule_numbers }),
      cached,
      usedFallback,
      fallbackLeague,
      originalLeague:       leagueName,
      answer_event_id,
      // V3 retrieval metadata
      league_slug,
      active_version_id,
      fallback_version_id:  fallback_version_id ?? null,
      retrieved_source_ids,
      cited_rule_numbers,
      verifier_status:      verifierAudit.status,
      league_display_name,
      league_website_url,
      league_link_text,
      fallback_league_display_name,
      fallback_league_website_url,
      fallback_league_link_text,
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
