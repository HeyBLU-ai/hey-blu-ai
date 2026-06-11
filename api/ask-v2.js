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
 *   league       {string}  — league key (optional, defaults to MLB)
 *   conversation {Array}   — prior Q/A turns for context (optional)
 *   matrix_state {object}  — present on follow-up requests during an interview:
 *                             { matrix_id: string, answers: { [question_id]: string } }
 *
 * Response shapes:
 *   State A: { state: "answered",            reply, usedFallback, fallbackLeague, originalLeague }
 *   State B: { state: "needs_clarification", matrix_id, matrix_label, current_question,
 *               progress: { answered, remaining_estimated } }
 *   State C: { state: "ruling",              reply, usedFallback, fallbackLeague, originalLeague,
 *               matrix_id, answers_used }
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
function resolveLeague(league) {
  const leagueNorm = sanitizeInput(league ?? '', 50).toLowerCase();
  if (leagueNorm === 'usssa' || leagueNorm === 'usssa baseball')                      return { slug: 'usssa',           leagueName: 'USSSA Baseball' };
  if (leagueNorm === 'little league' || leagueNorm === 'little league international') return { slug: 'little-league',    leagueName: 'Little League International' };
  if (leagueNorm === 'mill valley aaa' || leagueNorm === 'mill valley')               return { slug: 'mill-valley-aaa',  leagueName: 'Mill Valley AAA' };
  if (leagueNorm === 'bamsbl')                                                         return { slug: 'bamsbl',           leagueName: 'Bay Area Men\'s Senior Baseball League' };
  return { slug: 'mlb', leagueName: 'MLB Official Rules of Baseball' };
}

// ── Anthropic client ─────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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

// ── Full-Context Answer Pipeline ─────────────────────────────────────────────
//
// Fetches ALL rules for the requested league from the DB and sends them to
// Claude in a single prompt. No vector search, no thresholds, no fallbacks
// based on embedding distance. Claude reads every rule and finds the answer
// the same way a human would flip through a rulebook.
//
// If the league has a parent (e.g. BAMSBL → MLB), parent rules are appended
// so Claude can reference them for topics the local league doesn't override.

async function runRAG({ sanitizedQuestion, league, conversation, extraContext = '' }) {
  const { slug: leagueSlug, leagueName } = resolveLeague(league);

  if (!pool) throw new Error('DATABASE_URL not configured');
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY not configured');

  const dbClient = await pool.connect();
  let leagueRules = [], parentRules = [], parentName = null;

  try {
    // Fetch all rules for the requested league
    const leagueRes = await dbClient.query(`
      SELECT l.name AS league_name, l.parent_league_id,
             r.rule_number, r.title, r.body
      FROM   rules r
      JOIN   leagues l ON l.id = r.league_id
      WHERE  l.slug = $1
      ORDER  BY r.rule_number
    `, [leagueSlug]);

    if (leagueRes.rows.length > 0) {
      leagueRules = leagueRes.rows;
      const parentId = leagueRes.rows[0].parent_league_id;

      // Fetch parent league rules if one exists
      if (parentId) {
        const parentRes = await dbClient.query(`
          SELECT l.name AS league_name, r.rule_number, r.title, r.body
          FROM   rules r
          JOIN   leagues l ON l.id = r.league_id
          WHERE  l.id = $1
          ORDER  BY r.rule_number
        `, [parentId]);
        parentRules = parentRes.rows;
        parentName  = parentRes.rows[0]?.league_name ?? null;
      }
    } else {
      // Fallback: league not in DB yet — fetch MLB
      const mlbRes = await dbClient.query(`
        SELECT l.name AS league_name, r.rule_number, r.title, r.body
        FROM   rules r
        JOIN   leagues l ON l.id = r.league_id
        WHERE  l.slug = 'mlb'
        ORDER  BY r.rule_number
      `);
      leagueRules = mlbRes.rows;
    }
  } finally {
    dbClient.release();
  }

  // Format rules as a readable numbered list
  const formatRules = (rows) =>
    rows.map(r => `Rule ${r.rule_number}: ${r.title}\n${r.body}`).join('\n\n');

  const leagueRulesText  = formatRules(leagueRules);
  const parentRulesText  = parentRules.length > 0 ? formatRules(parentRules) : null;

  const validatedConversation = validateConversation(conversation);
  const historyText = validatedConversation.length > 0
    ? 'Conversation history:\n' +
      validatedConversation.map(t => `User: ${t.user}\nAssistant: ${t.ai}`).join('\n\n') + '\n\n'
    : '';

  const prompt = `You are an expert baseball rules official for the ${leagueName}.

Your job: answer the umpire's question accurately by reading the rulebook below. Always cite the specific rule number.

${extraContext ? `PLAY CONTEXT:\n${extraContext}\n\n` : ''}\
${historyText}\
QUESTION: ${sanitizedQuestion}

${leagueName.toUpperCase()} RULEBOOK (${leagueRules.length} rules):
${leagueRulesText}
${parentRulesText ? `\n\n${parentName?.toUpperCase() ?? 'PARENT LEAGUE'} RULEBOOK — applies where ${leagueName} has no specific rule (${parentRules.length} rules):\n${parentRulesText}` : ''}

Instructions:
- Search the rulebook above for every rule relevant to this question.
- Give a clear, plain-English answer an umpire can act on immediately.
- Cite the rule number(s) you are drawing from.
- If the ${leagueName} rulebook has a specific rule, use that. Only reference the parent rulebook if the local league has no applicable rule.
- If no rule covers the question at all, say so plainly.

Answer:`;

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  const reply = message.content[0]?.text?.trim() || 'No answer received.';
  return { reply, usedFallback: false, fallbackLeague: null, leagueName };
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

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OpenAI API key' });
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
        const { reply, usedFallback, fallbackLeague, leagueName } = await runRAG({
          sanitizedQuestion,
          league,
          conversation,
          extraContext,
        });

        logToDb({ sanitizedQuestion, reply, leagueName, usedFallback, fallbackLeague });

        return res.status(200).json({
          state:          'ruling',
          matrix_id:      matrix.id,
          answers_used:   matrixState.answers,
          reply,
          usedFallback,
          fallbackLeague,
          originalLeague: leagueName,
        });
      }
    }

    // ── 4. New question: route via pre-screen + classifier ─────────────────
    //
    //   Step 1: Keyword pre-screen (zero latency, no API call).
    //           If no keyword match → question is almost certainly factual →
    //           skip classifier and go straight to RAG (State A).
    //
    //   Step 2: If keyword match → call GPT-4o-mini to confirm and to identify
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
    const { reply, usedFallback, fallbackLeague, leagueName } = await runRAG({
      sanitizedQuestion,
      league,
      conversation,
    });

    logToDb({ sanitizedQuestion, reply, leagueName, usedFallback, fallbackLeague });

    return res.status(200).json({
      state:          'answered',
      reply,
      usedFallback,
      fallbackLeague,
      originalLeague: leagueName,
    });

  } catch (err) {
    console.error('[ask-v2] ERROR:', err.message);
    console.error('[ask-v2] Stack:', err.stack);
    return res.status(500).json({ error: 'Something went wrong processing the rules.' });
  }
};

export default withCors(handler);
