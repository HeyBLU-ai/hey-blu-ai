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
 * Maps a league string (from the client) to the JSON data files used by
 * the RAG pipeline. Returns { rulesFileName, embeddingsFileName, leagueName }.
 */
function resolveLeague(league) {
  const leagueNorm = sanitizeInput(league ?? '', 50).toLowerCase();

  if (leagueNorm === 'usssa' || leagueNorm === 'usssa baseball') {
    return { rulesFileName: 'usssa-rules.json', embeddingsFileName: 'usssa-rules-embeddings.json', leagueName: 'USSSA Baseball' };
  }
  if (leagueNorm === 'little league' || leagueNorm === 'little league international') {
    return { rulesFileName: 'little-league-international.json', embeddingsFileName: null, leagueName: 'Little League International' };
  }
  if (leagueNorm === 'mill valley aaa' || leagueNorm === 'mill valley') {
    return { rulesFileName: 'mill-valley-aaa-rules.json', embeddingsFileName: 'mill-valley-aaa-rules-embeddings.json', leagueName: 'Mill Valley AAA' };
  }
  if (leagueNorm === 'bamsbl') {
    return { rulesFileName: 'bamsbl-rules.json', embeddingsFileName: 'bamsbl-rules-embeddings.json', leagueName: 'BAMSBL' };
  }
  // Default: MLB
  return { rulesFileName: 'rules-mlb.json', embeddingsFileName: 'rules-mlb-embeddings.json', leagueName: 'MLB' };
}

/**
 * Maps the same league identifier strings to their Postgres slugs.
 */
function resolveLeagueSlug(league) {
  const leagueNorm = sanitizeInput(league ?? '', 50).toLowerCase();
  if (leagueNorm === 'usssa' || leagueNorm === 'usssa baseball')                    return 'usssa';
  if (leagueNorm === 'little league' || leagueNorm === 'little league international') return 'little-league';
  if (leagueNorm === 'mill valley aaa' || leagueNorm === 'mill valley')             return 'mill-valley-aaa';
  if (leagueNorm === 'bamsbl')                                                       return 'bamsbl';
  return 'mlb';
}

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
  const userContent = `Question: "${question}"\n\nReturn JSON: { "classification": "judgment"|"factual", "matrix_id": string|null, "confidence": 0.0-1.0, "reasoning": "one sentence" }`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:           'gpt-4o-mini',
        messages:        [
          { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature:     0,
        max_tokens:      150,
      }),
    });

    if (!res.ok) {
      console.warn('[ask-v2] Classifier HTTP error:', res.status);
      return null;
    }

    const data   = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? 'null');

    if (!parsed || typeof parsed.classification !== 'string') return null;
    return parsed;
  } catch (err) {
    console.warn('[ask-v2] Classifier failed (falling through to RAG):', err.message);
    return null;
  }
}

// ── RAG Pipeline ─────────────────────────────────────────────────────────────

/**
 * Runs the full retrieval-augmented generation pipeline.
 *
 * @param {object} params
 * @param {string} params.sanitizedQuestion  — already-cleaned question string
 * @param {string} params.league             — raw league identifier from client
 * @param {Array}  params.conversation       — raw conversation array from client
 * @param {string} [params.extraContext='']  — play-context injected before the Q
 *                                             (populated when in State C ruling mode)
 *
 * @returns {{ reply, usedFallback, fallbackLeague, leagueName }}
 */
async function runRAG({ sanitizedQuestion, league, conversation, extraContext = '' }) {
  const { leagueName } = resolveLeague(league);
  const leagueSlug     = resolveLeagueSlug(league);

  if (!pool) throw new Error('DATABASE_URL not configured');

  // ── 1. Embed the question ────────────────────────────────────────────────

  const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: sanitizedQuestion }),
  });
  if (!embedRes.ok) throw new Error(`OpenAI embeddings error ${embedRes.status}`);
  const embedData   = await embedRes.json();
  const questionVec = embedData.data[0].embedding;
  const vecStr      = `[${questionVec.join(',')}]`;

  // ── 2. pgvector semantic search ──────────────────────────────────────────

  const SEARCH_SQL = `
    SELECT
      r.rule_number,
      r.title,
      r.body,
      (re.embedding <=> $2::vector) AS distance
    FROM  rule_embeddings re
    JOIN  rules    r ON r.id  = re.rule_id
    JOIN  leagues  l ON l.id  = r.league_id
    WHERE l.slug      = $1
      AND re.model    = 'text-embedding-3-small'
    ORDER BY distance
    LIMIT 10
  `;

  let selectedRules  = [];
  let usedFallback   = false;
  let fallbackLeague = null;

  const dbClient = await pool.connect();
  try {
    const { rows } = await dbClient.query(SEARCH_SQL, [leagueSlug, vecStr]);
    selectedRules = rows.map(r => ({
      id:       `Rule ${r.rule_number}`,
      text:     `${r.title}\n${r.body}`,
      distance: parseFloat(r.distance),
    }));

    // ── 3. Fallback to parent league when top match is poor ────────────────
    //   Threshold 0.45 (cosine distance 0 = identical, 1 = orthogonal).
    //   Also falls back when the league has fewer than 3 rules in the DB.
    const bestDistance = selectedRules[0]?.distance ?? 1;
    if (bestDistance > 0.45 || selectedRules.length < 3) {
      const parentRes = await dbClient.query(`
        SELECT l2.slug, l2.name
        FROM   leagues l
        JOIN   leagues l2 ON l2.id = l.parent_league_id
        WHERE  l.slug = $1
      `, [leagueSlug]);

      if (parentRes.rows.length > 0) {
        const { slug: parentSlug, name: parentName } = parentRes.rows[0];
        const { rows: parentRows } = await dbClient.query(SEARCH_SQL, [parentSlug, vecStr]);

        if (parentRows.length > 0) {
          usedFallback   = true;
          fallbackLeague = parentName;
          selectedRules  = parentRows.map(r => ({
            id:       `Rule ${r.rule_number}`,
            text:     `${r.title}\n${r.body}`,
            distance: parseFloat(r.distance),
          }));
        }
      }
    }
  } finally {
    dbClient.release();
  }

  // ── Prompt construction ──────────────────────────────────────────────────

  const context             = selectedRules.map(r => `${r.id}: ${r.text}`).join('\n\n');
  const validatedConversation = validateConversation(conversation);
  let historyContext        = '';
  if (validatedConversation.length > 0) {
    historyContext =
      'Here is the history of our current conversation:\n' +
      validatedConversation.map(t => `User: ${t.user}\nAssistant: ${t.ai}`).join('\n\n') +
      '\n\nPlease use this history to inform your answer to the new question.';
  }

  const activeLeague = usedFallback ? fallbackLeague : leagueName;

  const prompt = `\
You are an expert on the ${activeLeague} rulebook. Your task is to answer a user's question clearly and concisely, citing the most relevant rule(s).
You will be given the conversation history, the user's latest question, and a set of relevant rules.
${usedFallback ? `\n**IMPORTANT:** The user asked about ${leagueName} rules, but this specific question is not covered in the ${leagueName} rulebook. You are now using ${fallbackLeague} rules as the fallback source. Keep your response concise.\n` : ''}
${extraContext ? `\n**PLAY CONTEXT (USE THIS TO INFORM YOUR RULING):**\n${extraContext}\n` : ''}
Follow these steps precisely:
1.  **Analyze the Conversation History (if provided):** Understand the context of what has already been discussed.
2.  **Analyze the User's Latest Question:** Identify the core concept, mapping colloquial terms to official terminology.
3.  **Find the Relevant Rule(s):** Search the provided rules to find the most relevant rule(s) for the LATEST question.
4.  **Synthesize the Answer:**
    * If play context is provided above, use it to make your ruling specific to the described situation.
    * Provide a concise, plain-English summary.
    * Then, cite the single most important rule number and the most relevant sentence from that rule.
    ${usedFallback ? `* **CRITICAL:** For fallback responses, state "Referencing ${fallbackLeague} rulebook because the provided ${leagueName} rulebook does not have a rule citation for this question." then cite normally.` : ''}
5.  **Construct the Final Response:** Format your response exactly as shown in the example below, with no extra labels or conversational text.

---
**EXAMPLE**

**User Question:** what happens if a batter is hit by a pitch?

**Your Response:**
A batter is awarded first base if they are hit by a pitch, provided they made an attempt to avoid it and the pitch was not a strike.

Rule 5.05(b)(2): "*He is touched by a pitched ball which he is not attempting to hit unless (A) The ball is in the strike zone when it touches the batter, or (B) The batter makes no attempt to avoid being touched by the ball;*"
---

**Your Task**
${historyContext ? `---\n**Conversation History**\n${historyContext}\n---` : ''}

**User's Latest Question:** "${sanitizedQuestion}"

**Relevant ${activeLeague} Rules:**
${context}

Answer:`;

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       'gpt-4o',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  });

  const data  = await openaiRes.json();
  const reply = data?.choices?.[0]?.message?.content || 'No answer received.';

  return { reply, usedFallback, fallbackLeague, leagueName };
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
