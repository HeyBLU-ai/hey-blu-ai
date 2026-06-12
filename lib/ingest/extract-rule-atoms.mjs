/**
 * lib/ingest/extract-rule-atoms.mjs
 *
 * Uses an LLM (ANTHROPIC_FAST_MODEL) to extract atomic rule records from an
 * array of SourceSpans.  Each atom is the smallest independently applicable
 * rule unit — one obligation, permission, prohibition, or procedure that can
 * be looked up and cited verbatim.
 *
 * Architecture contract (NEVER RELAX):
 *   - The atom's `body` field must appear character-for-character in the text
 *     of at least one of its cited source spans (verified via indexOf).
 *   - The LLM's job is segmentation and labelling only — it must NOT rewrite,
 *     paraphrase, summarise, or truncate any rule text.
 *   - Atoms that fail the verbatim guard cause an immediate hard error (not a
 *     silent drop) so the caller knows the AI misbehaved.
 *
 * Processing strategy:
 *   Spans are sent to the LLM in batches (default: BATCH_SIZE per call).
 *   Each batch prompt includes the span IDs so the model can declare which
 *   span(s) each atom originates from.  The verbatim guard then confirms the
 *   declared span actually contains the body text.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 *
 * @typedef {Object} RuleAtom
 * @property {string}   sourceSpanId  - Primary source span UUID (FK → rule_sources.id).
 * @property {string[]} source_ids    - All span UUIDs that support this atom.
 * @property {string}   rule_number   - Official rule number (e.g. "505", "4.01", "505(a)").
 *                                      Empty string if none present in the source.
 * @property {string}   title         - One-line descriptor, ≤ 120 chars.
 * @property {string}   body          - VERBATIM text from the source span — never AI-authored.
 */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5';

/** Maximum spans per LLM call.  Keeps prompts well inside the context window. */
const BATCH_SIZE = 5;

/** How many chars of body/title to include in error messages. */
const PREVIEW = 120;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an Anthropic client from env vars, or return the provided override.
 *
 * @param {Object|undefined} override
 * @returns {Anthropic}
 * @throws {Error} If no override and ANTHROPIC_API_KEY is absent.
 */
function buildClient(override) {
  if (override) return override;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'extractRuleAtoms: ANTHROPIC_API_KEY env var is required. ' +
      'Pass opts.anthropicClient to run without a live API key (e.g. in tests).',
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * Construct the extraction prompt for one batch of spans.
 *
 * The prompt:
 *   1. Provides each span as { id, text } so the model can reference IDs.
 *   2. Demands verbatim body text — character-for-character copy from the span.
 *   3. Requests only a JSON object — no markdown, no prose.
 *
 * @param {SourceSpan[]} batchSpans
 * @param {string[]}     batchIds
 * @returns {string}
 */
function buildBatchPrompt(batchSpans, batchIds) {
  const spanEntries = batchSpans
    .map((span, i) => JSON.stringify({ id: batchIds[i], text: span.text }))
    .join(',\n  ');

  return `You are a baseball rulebook parser.  Extract every atomic rule from the source spans below.

An "atomic rule" is the smallest independently applicable unit: one obligation, permission, prohibition, or procedure that can be cited on its own.

For each atom return exactly these fields:
  "rule_number" – the official rule identifier (e.g. "505", "4.01", "505(a)"). Use "" if none is stated.
  "title"       – one-line descriptor, ≤120 characters.
  "body"        – EXACT verbatim text copied character-for-character from one of the spans below.  Do NOT paraphrase, summarise, truncate, or alter any character.
  "source_ids"  – JSON array of span id strings whose text contains this atom.

STRICT RULES:
1. "body" must be EXACTLY verbatim text — every character, every space, no substitutions.
2. "source_ids" must only reference the ids provided below.
3. Respond with ONLY a JSON object — no markdown fences, no prose, no explanations.
4. If no atomic rules can be identified, respond with {"atoms":[]}.

Required format:
{"atoms":[{"rule_number":"505","title":"Must Slide Rule","body":"exact verbatim text here","source_ids":["span-id-here"]}]}

Source spans:
[
  ${spanEntries}
]`;
}

/**
 * Extract the first complete JSON object from a string that may include
 * markdown fences or leading/trailing prose.
 *
 * @param {string} raw
 * @returns {unknown}
 * @throws {SyntaxError} If no valid JSON object is found.
 */
function extractJson(raw) {
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError('no JSON object found in AI response');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Verify that an atom's body appears verbatim in at least one of its cited
 * source spans.  Throws on any failure — the caller decides whether to retry.
 *
 * VERBATIM GUARD: body must pass String.prototype.indexOf against span.text.
 *
 * @param {Object}              atom      - Atom returned by the LLM.
 * @param {Map<string,SourceSpan>} spansById - spanId → SourceSpan lookup.
 * @throws {Error} If source_ids is missing/empty, references an unknown span,
 *                 or body is not found in any cited span.
 */
function verifyAtomVerbatim(atom, spansById) {
  if (!Array.isArray(atom.source_ids) || atom.source_ids.length === 0) {
    throw new Error(
      `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
      `atom "${String(atom.title ?? '').slice(0, PREVIEW)}" has no source_ids.`,
    );
  }

  for (const sid of atom.source_ids) {
    const span = spansById.get(sid);
    if (!span) {
      throw new Error(
        `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
        `atom "${String(atom.title ?? '').slice(0, PREVIEW)}" ` +
        `references unknown span id "${sid}".`,
      );
    }
    if (span.text.indexOf(atom.body) !== -1) {
      return; // guard passed
    }
  }

  throw new Error(
    `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
    `atom body not found verbatim in any cited source span.\n` +
    `Title (first ${PREVIEW} chars): "${String(atom.title ?? '').slice(0, PREVIEW)}"\n` +
    `Body  (first ${PREVIEW} chars): "${String(atom.body  ?? '').slice(0, PREVIEW)}"\n` +
    `Tip: AI may have paraphrased, summarised, or altered the rule text.`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract rule atoms from an array of SourceSpans using an LLM.
 *
 * Sends spans to the model in batches.  For each batch the model returns a
 * JSON array of atoms; each atom's `body` is verified verbatim against its
 * declared source span(s) before the atom is accepted.
 *
 * @param {Object}       opts
 * @param {SourceSpan[]} opts.spans            - Parsed source spans (must have .text and .seq).
 * @param {string[]}     opts.spanIds          - DB UUIDs for each span (parallel to opts.spans).
 * @param {Object}       [opts.anthropicClient] - Client override for testing (avoids real API).
 * @param {string}       [opts.model]          - Anthropic model ID override.
 * @param {number}       [opts.batchSize]      - Spans per LLM call (default: 5).
 * @returns {Promise<RuleAtom[]>}              All verified atoms across all batches.
 * @throws {Error}  If inputs are invalid, the API call fails, the response
 *                  cannot be parsed, or any atom fails the verbatim guard.
 */
export async function extractRuleAtoms(opts = {}) {
  if (!Array.isArray(opts.spans) || opts.spans.length === 0) {
    throw new Error('extractRuleAtoms: opts.spans must be a non-empty array.');
  }
  if (!Array.isArray(opts.spanIds) || opts.spanIds.length !== opts.spans.length) {
    throw new Error(
      'extractRuleAtoms: opts.spanIds must be a parallel array matching opts.spans length.',
    );
  }

  const client    = buildClient(opts.anthropicClient);
  const model     = opts.model ?? DEFAULT_MODEL;
  const batchSize = opts.batchSize ?? BATCH_SIZE;

  // Build a lookup map for the verbatim guard: spanId → span
  const spansById = new Map();
  for (let i = 0; i < opts.spans.length; i++) {
    spansById.set(opts.spanIds[i], opts.spans[i]);
  }

  const allAtoms = [];

  // Process in batches
  for (let bStart = 0; bStart < opts.spans.length; bStart += batchSize) {
    const batchSpans = opts.spans.slice(bStart, bStart + batchSize);
    const batchIds   = opts.spanIds.slice(bStart, bStart + batchSize);

    const prompt = buildBatchPrompt(batchSpans, batchIds);

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = response?.content?.[0]?.text ?? '';
    if (!raw.trim()) {
      throw new Error('extractRuleAtoms: AI returned an empty response for batch.');
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (e) {
      throw new Error(
        `extractRuleAtoms: could not parse AI response as JSON — ${e.message}.\n` +
        `Raw response (first 300 chars): "${raw.slice(0, 300)}"`,
      );
    }

    if (!Array.isArray(parsed.atoms)) {
      throw new Error(
        `extractRuleAtoms: AI response missing "atoms" array.\n` +
        `Raw response (first 300 chars): "${raw.slice(0, 300)}"`,
      );
    }

    for (const atom of parsed.atoms) {
      // Require a non-empty body before touching spansById
      if (typeof atom.body !== 'string' || !atom.body.trim()) {
        throw new Error(
          `extractRuleAtoms: atom has missing or empty "body" field: ` +
          `${JSON.stringify(atom).slice(0, 200)}`,
        );
      }

      // ── VERBATIM GUARD ────────────────────────────────────────────────────
      verifyAtomVerbatim(atom, spansById);

      allAtoms.push({
        sourceSpanId: atom.source_ids[0],
        source_ids:   atom.source_ids,
        rule_number:  String(atom.rule_number ?? ''),
        title:        String(atom.title ?? ''),
        body:         atom.body,
      });
    }
  }

  return allAtoms;
}
