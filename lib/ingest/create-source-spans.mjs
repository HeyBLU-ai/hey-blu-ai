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
import { findNormalizedSubstring } from './utils.mjs';

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
  // Two-pass sanitization before JSON.parse:
  //
  // Pass 1 — whitespace control chars (tab, CR, LF) → single space.
  //   LLMs sometimes embed literal newlines or tabs inside JSON string values
  //   (e.g. when quoting multi-line rule text).  These are illegal in JSON and
  //   would cause a parse error.  We convert them to spaces to match the
  //   whitespace-normalised form of our source span text.
  //   Note: \r\n must be tried before \r/\n so we collapse it to one space.
  //
  // Pass 2 — remaining non-whitespace control chars (0x00–0x08, 0x0b, 0x0c,
  //   0x0e–0x1f, 0x7f) → \\uXXXX escape, preserving the byte without crashing
  //   JSON.parse.
  //
  // Finally, .trim() removes any leading/trailing whitespace or markdown-fence
  // artifacts that might have crept in at the slice boundaries.
  const sanitized = raw.slice(start, end + 1)
    .replace(/\t|\r\n|\r|\n/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  return JSON.parse(sanitized.trim());
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
      max_tokens: 8192,
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

    // ── VERBATIM GUARD (normalisation-tolerant) ──────────────────────────────
    // findNormalizedSubstring locates the AI's quote in the source text after
    // normalising both sides for whitespace, capitalisation, smart quotes, and
    // typographic dashes.  Formatting artefacts that are excused:
    //   • extra/missing/different whitespace (tab → space, double space, etc.)
    //   • capitalisation changes
    //   • typographic vs. straight quotes or dashes
    // What is NOT excused (still causes null → hard stop):
    //   • added, removed, or substituted words
    //   • semantic rewrites or paraphrasing
    const range = findNormalizedSubstring(spanText, verbatim);
    if (range === null) {
      throw new Error(
        `identifyBoundaries: VERBATIM GUARD FAILED.\n` +
        `AI returned text whose words do not match the source span (even after whitespace/punctuation normalisation).\n` +
        `AI text   (first 120 chars): "${verbatim.slice(0, 120)}"\n` +
        `Source text (first 120 chars): "${spanText.slice(0, 120)}"\n` +
        `Tip: retry ingestion or inspect the AI model's response for paraphrasing.`,
      );
    }

    // Output text is ALWAYS sliced from the original source — never from the
    // AI response.  This preserves the canonical source wording.
    const [localStart, localEnd] = range;
    boundaries.push({
      charStart: baseOffset + localStart,
      charEnd:   baseOffset + localEnd,
      text:      spanText.slice(localStart, localEnd),
    });
  }

  // Fall back to whole span if all rules filtered out (e.g., all were empty).
  if (boundaries.length === 0) {
    return [{ charStart: baseOffset, charEnd: baseOffset + spanText.length, text: spanText }];
  }

  return boundaries;
}

// ── Parameterized INSERT for rule_sources ────────────────────────────────────
// Columns match RULEBOOK_DB_MIGRATION_V3.sql exactly.
// $8 is JSONB — we pass a JSON string; pg casts it automatically.
const INSERT_RULE_SOURCE_SQL = `
  INSERT INTO rule_sources
    (document_id, page_start, page_end, section_path, char_start, char_end, exact_text, parse_warnings)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id
`.trim();

/**
 * Execute the INSERT for a single span.
 *
 * @param {Object} dbClient  - pg Pool or compatible client (must have .query(text, values)).
 * @param {string} documentId
 * @param {Object} span      - A SourceSpan or SpanBoundary (text, charStart, charEnd, page, heading).
 * @returns {Promise<string>} The UUID of the inserted rule_sources row.
 */
async function insertOneSpan(dbClient, documentId, span) {
  const warnings = JSON.stringify(span.parse_warnings ?? []);
  const result   = await dbClient.query(INSERT_RULE_SOURCE_SQL, [
    documentId,             // $1  document_id
    span.page   ?? null,    // $2  page_start
    span.page   ?? null,    // $3  page_end (same as start — single-page anchoring for now)
    span.heading ?? null,   // $4  section_path
    span.charStart ?? null, // $5  char_start
    span.charEnd   ?? null, // $6  char_end
    span.text,              // $7  exact_text
    warnings,               // $8  parse_warnings (JSONB)
  ]);
  return result.rows[0].id;
}

/**
 * Insert SourceSpans for a rulebook document into the `rule_sources` table.
 *
 * Accepts two calling conventions:
 *
 *   NEW (Step 8) — provide documentId + dbClient:
 *     createSourceSpans({ dbClient, documentId, spans })
 *     → Performs real INSERT queries, returns { inserted: N, ids: [uuid, …] }
 *
 *   LEGACY (Step 5 stub, used by skeleton tests) — provide db + versionId:
 *     createSourceSpans({ db, versionId, spans })
 *     → Returns stub { inserted: 0 } without touching the DB.
 *
 * @param {Object}            opts
 * @param {Object}            [opts.dbClient]    - Injected pg client (real or mock). Takes priority over opts.db.
 * @param {import('pg').Pool} [opts.db]          - pg Pool. Used when opts.dbClient is absent.
 * @param {string}            [opts.documentId]  - UUID of the rule_documents row (new path).
 * @param {string}            [opts.versionId]   - UUID of the rulebook_versions row (legacy path).
 * @param {SourceSpan[]}      opts.spans         - Ordered array of parsed SourceSpans.
 * @param {string}            [opts.model]       - Anthropic model ID override.
 * @param {Object}            [opts.anthropicClient] - Anthropic client override for testing.
 * @returns {Promise<{ inserted: number, ids?: string[] }>}
 * @throws {Error}  If neither db nor dbClient is supplied; if neither versionId nor documentId
 *                  is supplied; or if spans is empty/invalid.
 */
export async function createSourceSpans(opts = {}) {
  const dbClient = opts.dbClient ?? opts.db;
  if (!dbClient) {
    throw new Error('createSourceSpans: opts.db (pg Pool) is required.');
  }
  if (!opts.versionId && !opts.documentId) {
    throw new Error('createSourceSpans: opts.versionId is required.');
  }
  if (!Array.isArray(opts.spans) || opts.spans.length === 0) {
    throw new Error('createSourceSpans: opts.spans must be a non-empty array of SourceSpans.');
  }

  for (const span of opts.spans) {
    if (typeof span.seq  !== 'number') throw new Error('createSourceSpans: each span must have a numeric seq.');
    if (typeof span.text !== 'string' || span.text.trim() === '') {
      throw new Error(`createSourceSpans: span[${span.seq}].text is empty.`);
    }
  }

  // ── Real insert path (documentId provided) ────────────────────────────────
  if (opts.documentId) {
    const ids = [];
    for (const span of opts.spans) {
      const id = await insertOneSpan(dbClient, opts.documentId, span);
      ids.push(id);
    }
    return { inserted: ids.length, ids };
  }

  // ── Legacy stub path (versionId only, no documentId) ─────────────────────
  return { inserted: 0 };
}
