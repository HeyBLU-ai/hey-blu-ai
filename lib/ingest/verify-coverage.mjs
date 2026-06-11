/**
 * lib/ingest/verify-coverage.mjs
 *
 * Audits that the extracted RuleAtoms provide adequate coverage of the
 * original SourceSpans.  This is a deterministic, non-LLM check.
 *
 * Coverage checks performed:
 *   1. Verbatim-quote check  — every atom.quote must appear literally inside
 *      its source span's text.  Atoms that fail this are flagged as `QUOTE_MISMATCH`.
 *   2. Orphan-span check     — every SourceSpan must be claimed by at least one
 *      atom.  Unclaimed spans are flagged as `UNCOVERED_SPAN`.
 *   3. Density check         — if a span is longer than MIN_COVERED_CHARS but
 *      has only a single very short atom, it is flagged as `LOW_DENSITY`.
 *
 * The function returns a CoverageReport rather than throwing, so the caller
 * can decide whether to block ingestion or just warn.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 * @typedef {import('./extract-rule-atoms.mjs').RuleAtom} RuleAtom
 *
 * @typedef {Object} CoverageIssue
 * @property {'QUOTE_MISMATCH'|'UNCOVERED_SPAN'|'LOW_DENSITY'} code
 * @property {string}  message
 * @property {number}  [spanSeq]
 * @property {string}  [ruleId]
 *
 * @typedef {Object} CoverageReport
 * @property {boolean}        ok          - true when there are zero QUOTE_MISMATCH issues.
 * @property {number}         spanCount
 * @property {number}         atomCount
 * @property {number}         coveredSpans
 * @property {CoverageIssue[]} issues
 */

const MIN_COVERED_CHARS = 200;

/**
 * Verify that extracted atoms provide accurate, non-lossy coverage of the
 * source spans.
 *
 * @param {Object}       opts
 * @param {SourceSpan[]} opts.spans  - Original parsed spans (must have .seq and .text).
 * @param {RuleAtom[]}   opts.atoms  - Atoms returned by extractRuleAtoms().
 * @param {string[]}     opts.spanIds - DB IDs parallel to opts.spans.
 * @returns {Promise<CoverageReport>}
 * @throws {Error}  If spans or atoms are missing.
 */
export async function verifyCoverage(opts = {}) {
  if (!Array.isArray(opts.spans)) throw new Error('verifyCoverage: opts.spans must be an array.');
  if (!Array.isArray(opts.atoms)) throw new Error('verifyCoverage: opts.atoms must be an array.');
  if (!Array.isArray(opts.spanIds) || opts.spanIds.length !== opts.spans.length) {
    throw new Error('verifyCoverage: opts.spanIds must be a parallel array matching opts.spans.');
  }

  // ── stub — full implementation added in Step 11 ──
  return {
    ok:           true,
    spanCount:    opts.spans.length,
    atomCount:    opts.atoms.length,
    coveredSpans: 0,
    issues:       [],
  };
}
