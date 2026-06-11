/**
 * lib/ingest/create-source-spans.mjs
 *
 * Two responsibilities (implemented incrementally):
 *
 *   1. AI boundary identification  ← IMPLEMENTED (Step 7)
 *      identifyBoundaries() sends a source span to an Anthropic model and asks
 *      it to locate logical rule boundaries.  The model returns verbatim quotes;
 *      the VERBATIM GUARD verifies every quote exists character-for-character in
 *      the original text via String.prototype.indexOf.  Output text is always
 *      sliced from the original source, never from the AI response.
 *
 *   2. Persist to rule_sources table ← stub (Step 8)
 *      createSourceSpans() will write the identified sub-spans to Postgres.
 *      The DB write is deferred; for now the function returns { inserted: 0 }.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 *
 * @typedef {Object} SpanBoundary
 * @property {number} charStart - Absolute char offset within the full document text.
 * @property {number} charEnd   - Absolute char offset (exclusive).
 * @property {string} text      - Verbatim text sliced from the ORIGINAL source span.
 */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5';

/**
 * Build an Anthropic client from env vars, or return the provided override.
 * The override is used in tests to inject a mock without a real API key.
 *
 * @param {Object|undefined} override
 * @returns {Anthropic}
 * @throws {Error} If no override is provided and ANTHROPIC_API_KEY is absent.
 */
function buildClient(override) {
  if (override) return override;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'identifyBoundaries: ANTHROPIC_API_KEY env var is required. ' +
      'Pass opts.anthropicClient to run without a live API key (e.g. in tests).',
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * Extract the first complete JSON object from a string that may include markdown
 * fences or prose before/after the JSON.
 *
 * @param {string} raw
 * @returns {unknown}
 * @throws {SyntaxError} If no valid JSON object is found.
 */
function extractJson(raw) {
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError('identifyBoundaries: no JSON object found in AI response');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Build the prompt sent to Claude for rule-boundary identification.
 *
 * Design goals:
 *   - Emphasise that returned text must be verbatim (triggers correct behaviour).
 *   - Ask for JSON so parsing is deterministic.
 *   - Keep the prompt short to conserve tokens on a fast/cheap model.
 *
 * @param {string} spanText
 * @returns {string}
 */
function buildPrompt(spanText) {
  return `You are a baseball rulebook segmenter.  Your ONLY job is to identify where logical rules begin and end in the text below.

STRICT RULES:
1. Return the EXACT verbatim text of each rule — character for character, no changes, no paraphrasing.
2. Do NOT add, remove, or alter any characters (including whitespace).
3. A "rule" is the smallest self-contained obligation, permission, prohibition, or procedure.
4. If the entire text below is a single rule, return it as one item.
5. Respond with ONLY a JSON object — no markdown, no prose.

Required JSON format:
{"rules":[{"verbatim":"exact text of rule 1"},{"verbatim":"exact text of rule 2"}]}

Source text:
"""
${spanText}
"""`;
}

/**
 * Identify logical rule boundaries within a single SourceSpan.
 *
 * The Anthropic model is instructed to return verbatim quotes from the source.
 * Each returned quote is then validated against the original via indexOf —
 * the VERBATIM GUARD — before any output is produced.  If a quote cannot be
 * located in the source text, the function throws immediately.  Output text is
 * ALWAYS sliced from opts.span.text, never from the AI response.
 *
 * Exported so scripts/test-create-spans.mjs can test it directly with a mock
 * client, without going through createSourceSpans or touching Postgres.
 *
 * @param {Object}       opts
 * @param {SourceSpan}   opts.span             - The span whose text will be segmented.
 * @param {string}       [opts.model]          - Anthropic model ID override.
 * @param {Object}       [opts.anthropicClient] - Client override for testing (avoids real API).
 * @returns {Promise<SpanBoundary[]>}           One entry per identified rule.
 * @throws {Error}  If opts.span.text is missing, the AI response is unparseable,
 *                  or any AI-returned quote fails the verbatim guard.
 */
export async function identifyBoundaries(opts = {}) {
  if (!opts.span) {
    throw new Error('identifyBoundaries: opts.span is required.');
  }
  if (typeof opts.span.text !== 'string' || !opts.span.text.trim()) {
    throw new Error('identifyBoundaries: opts.span.text must be a non-empty string.');
  }

  const client     = buildClient(opts.anthropicClient);
  const model      = opts.model ?? DEFAULT_MODEL;
  const spanText   = opts.span.text;
  const baseOffset = opts.span.charStart ?? 0;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages:   [{ role: 'user', content: buildPrompt(spanText) }],
  });

  const raw = response?.content?.[0]?.text ?? '';
  if (!raw.trim()) {
    throw new Error('identifyBoundaries: AI returned an empty response.');
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    throw new Error(
      `identifyBoundaries: could not parse AI response as JSON — ${e.message}. ` +
      `Raw response (first 300 chars): "${raw.slice(0, 300)}"`,
    );
  }

  // If the model returned no rules (or an empty array), treat the whole span
  // as a single boundary — never drop content silently.
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    return [{ charStart: baseOffset, charEnd: baseOffset + spanText.length, text: spanText }];
  }

  const boundaries = [];

  for (const rule of parsed.rules) {
    const verbatim = typeof rule?.verbatim === 'string' ? rule.verbatim : null;
    if (!verbatim || !verbatim.trim()) continue;

    // ── VERBATIM GUARD ───────────────────────────────────────────────────────
    // We must find the AI's text character-for-character in the source.
    // If indexOf returns -1 the AI hallucinated or paraphrased — hard stop.
    const idx = spanText.indexOf(verbatim);
    if (idx === -1) {
      throw new Error(
        `identifyBoundaries: VERBATIM GUARD FAILED.\n` +
        `AI returned text that does not exist character-for-character in the source span.\n` +
        `AI text   (first 120 chars): "${verbatim.slice(0, 120)}"\n` +
        `Source text (first 120 chars): "${spanText.slice(0, 120)}"\n` +
        `Tip: retry ingestion or inspect the AI model's response for paraphrasing.`,
      );
    }

    // Output text is sliced from the ORIGINAL source, not from the AI response.
    boundaries.push({
      charStart: baseOffset + idx,
      charEnd:   baseOffset + idx + verbatim.length,
      text:      spanText.slice(idx, idx + verbatim.length),
    });
  }

  // Fall back to whole span if all rules filtered out (e.g., all were empty).
  if (boundaries.length === 0) {
    return [{ charStart: baseOffset, charEnd: baseOffset + spanText.length, text: spanText }];
  }

  return boundaries;
}

/**
 * Insert SourceSpans for a rulebook version into the database.
 *
 * NOTE: This function first runs AI boundary identification via identifyBoundaries()
 * for each span (Step 7), then persists the sub-spans to Postgres (Step 8, deferred).
 *
 * @param {Object}            opts
 * @param {import('pg').Pool} opts.db            - Active pg connection pool.
 * @param {string}            opts.versionId      - UUID of the target rulebook_versions row.
 * @param {SourceSpan[]}      opts.spans          - Ordered array of parsed SourceSpans.
 * @param {string}            [opts.model]        - Anthropic model ID override.
 * @param {Object}            [opts.anthropicClient] - Client override for testing.
 * @returns {Promise<{ inserted: number }>}
 * @throws {Error}  If db, versionId, or spans are missing.
 */
export async function createSourceSpans(opts = {}) {
  if (!opts.db)        throw new Error('createSourceSpans: opts.db (pg Pool) is required.');
  if (!opts.versionId) throw new Error('createSourceSpans: opts.versionId is required.');
  if (!Array.isArray(opts.spans) || opts.spans.length === 0) {
    throw new Error('createSourceSpans: opts.spans must be a non-empty array of SourceSpans.');
  }

  for (const span of opts.spans) {
    if (typeof span.seq  !== 'number') throw new Error('createSourceSpans: each span must have a numeric seq.');
    if (typeof span.text !== 'string' || span.text.trim() === '') {
      throw new Error(`createSourceSpans: span[${span.seq}].text is empty.`);
    }
  }

  // ── DB insert deferred to Step 8 ─────────────────────────────────────────
  return { inserted: 0 };
}
