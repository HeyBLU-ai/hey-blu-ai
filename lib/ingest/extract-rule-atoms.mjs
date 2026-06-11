/**
 * lib/ingest/extract-rule-atoms.mjs
 *
 * Uses an LLM (Claude claude-sonnet-4-6 by default) to extract atomic rule
 * records from an array of SourceSpans.  Each atom is the smallest
 * independently applicable rule unit — a single obligation, permission,
 * prohibition, or procedure that can be looked up and cited verbatim.
 *
 * An "atom" is NOT a paraphrase or summary.  The atom's `quote` field must
 * be verbatim text from the source span.  The LLM's job is segmentation and
 * labelling only.
 *
 * Output shape per atom:
 *   {
 *     sourceSpanId : string   — FK → rule_sources.id (provided by caller)
 *     ruleId       : string   — Human-readable ID from the document (e.g. "505(a)")
 *     title        : string   — One-line descriptor (≤120 chars)
 *     quote        : string   — Verbatim text from the span
 *     tags         : string[] — Semantic labels (e.g. ["baserunning","collision"])
 *     judgment     : boolean  — true if a human judgment call is required
 *   }
 *
 * Accuracy contract:
 *   - Every quote MUST appear verbatim in its source span's text.
 *   - Atoms that cannot be verified verbatim are dropped with a warning.
 *   - The caller must run verifyCoverage() after this step.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 * @typedef {Object} RuleAtom
 * @property {string}   sourceSpanId
 * @property {string}   ruleId
 * @property {string}   title
 * @property {string}   quote
 * @property {string[]} tags
 * @property {boolean}  judgment
 */

/**
 * Extract rule atoms from a set of SourceSpans using an LLM.
 *
 * @param {Object}       opts
 * @param {SourceSpan[]} opts.spans        - Parsed source spans (must have .text).
 * @param {string[]}     opts.spanIds      - DB IDs corresponding to each span (parallel array).
 * @param {string}       [opts.model]      - Anthropic model ID override. Defaults to env
 *                                           ANTHROPIC_ANSWER_MODEL or claude-sonnet-4-6.
 * @param {string}       [opts.apiKey]     - Anthropic API key override. Defaults to
 *                                           env ANTHROPIC_API_KEY.
 * @returns {Promise<RuleAtom[]>}          Verified atoms (quote present in source text).
 * @throws {Error}  If spans is empty, spanIds length mismatches, or API call fails.
 */
export async function extractRuleAtoms(opts = {}) {
  if (!Array.isArray(opts.spans) || opts.spans.length === 0) {
    throw new Error('extractRuleAtoms: opts.spans must be a non-empty array.');
  }
  if (!Array.isArray(opts.spanIds) || opts.spanIds.length !== opts.spans.length) {
    throw new Error('extractRuleAtoms: opts.spanIds must be a parallel array matching opts.spans length.');
  }

  // ── stub — full implementation added in Step 10 ──
  return [];
}
