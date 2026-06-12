/**
 * lib/ingest/verify-coverage.mjs
 *
 * Deterministic, non-LLM audit that the extracted RuleAtoms and SourceSpans
 * together provide complete, accurate coverage of the original document.
 *
 * Three span-level checks:
 *   QUOTE_MISMATCH  — atom.body must appear verbatim (indexOf) in the text of
 *                     each span it cites.  A mismatch means the AI violated the
 *                     verbatim contract and the data cannot be trusted.
 *   UNCOVERED_SPAN  — every SourceSpan must be claimed by at least one atom.
 *                     Unclaimed spans mean rule text was silently dropped.
 *   LOW_DENSITY     — a long span with only one very short atom is suspicious;
 *                     the AI may have collapsed multi-rule text into a single atom.
 *
 * One page-level check:
 *   Page coverage   — every page from 1 to totalPages must have at least one
 *                     span anchored to it.  Gaps flag missing extraction.
 *                     Pages are derived from span.page; documents that do not
 *                     track pages (e.g. DOCX via mammoth) are excluded from
 *                     this check (all page fields are null → isComplete = true).
 *
 * Returns a CoverageReport rather than throwing so the caller decides whether
 * to block ingestion (hard fail on QUOTE_MISMATCH) or just warn.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 * @typedef {import('./extract-rule-atoms.mjs').RuleAtom} RuleAtom
 *
 * @typedef {'QUOTE_MISMATCH'|'UNCOVERED_SPAN'|'LOW_DENSITY'} IssueCode
 *
 * @typedef {Object} CoverageIssue
 * @property {IssueCode} code
 * @property {string}    message
 * @property {number}    [spanSeq]  - seq of the offending span, when applicable.
 * @property {string}    [ruleId]   - DB UUID of the offending atom, when applicable.
 *
 * @typedef {Object} CoverageReport
 * @property {boolean}        ok            - false when any QUOTE_MISMATCH exists OR
 *                                            the page coverage is incomplete.
 * @property {boolean}        isComplete    - true when no pages are missing.
 * @property {number[]}       missingPages  - Page numbers (1-based) with no span.
 * @property {number}         totalPages    - Highest page number seen in spans (or opts.totalPages).
 * @property {number}         coveredPages  - Distinct page numbers that have ≥1 span.
 * @property {number}         spanCount     - Total input spans.
 * @property {number}         atomCount     - Total input atoms.
 * @property {number}         coveredSpans  - Spans claimed by ≥1 atom.
 * @property {CoverageIssue[]} issues       - All detected issues across all checks.
 */

/**
 * Minimum span length (chars) for the LOW_DENSITY check to apply.
 * Short spans (e.g. a lone section heading) are exempt.
 */
const MIN_COVERED_CHARS = 200;

/**
 * Minimum atom body length (chars).  A body shorter than this on a long span
 * is flagged as LOW_DENSITY.
 */
const MIN_ATOM_BODY_CHARS = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the highest 1-based page number from a set of spans.
 * Spans with page === null are excluded (e.g. DOCX parsed via mammoth).
 *
 * @param {SourceSpan[]} spans
 * @returns {number} 0 if no spans carry page information.
 */
function maxPageFromSpans(spans) {
  let max = 0;
  for (const s of spans) {
    if (typeof s.page === 'number' && s.page > max) max = s.page;
  }
  return max;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verify that extracted atoms provide accurate, non-lossy coverage of the
 * source spans and every page of the original document.
 *
 * @param {Object}       opts
 * @param {SourceSpan[]} opts.spans       - Original parsed spans (.seq, .text, .page).
 * @param {RuleAtom[]}   opts.atoms       - Atoms returned by extractRuleAtoms().
 * @param {string[]}     opts.spanIds     - DB UUIDs parallel to opts.spans.
 * @param {number}       [opts.totalPages] - Override for the expected page count.
 *                                          When omitted, derived from the highest
 *                                          span.page value found in opts.spans.
 * @returns {Promise<CoverageReport>}
 * @throws {Error} If spans, atoms, or spanIds are missing / mismatched.
 */
export async function verifyCoverage(opts = {}) {
  if (!Array.isArray(opts.spans)) {
    throw new Error('verifyCoverage: opts.spans must be an array.');
  }
  if (!Array.isArray(opts.atoms)) {
    throw new Error('verifyCoverage: opts.atoms must be an array.');
  }
  if (!Array.isArray(opts.spanIds) || opts.spanIds.length !== opts.spans.length) {
    throw new Error('verifyCoverage: opts.spanIds must be a parallel array matching opts.spans.');
  }

  const issues = [];

  // ── Build lookup maps ──────────────────────────────────────────────────────
  /** spanId → SourceSpan */
  const spansById = new Map();
  for (let i = 0; i < opts.spans.length; i++) {
    spansById.set(opts.spanIds[i], opts.spans[i]);
  }

  /** spanId → RuleAtom[] (atoms that cite this span) */
  const atomsBySpanId = new Map();
  for (const atom of opts.atoms) {
    for (const sid of (atom.source_ids ?? [])) {
      if (!atomsBySpanId.has(sid)) atomsBySpanId.set(sid, []);
      atomsBySpanId.get(sid).push(atom);
    }
  }

  // ── Check 1: QUOTE_MISMATCH ────────────────────────────────────────────────
  // Every atom.body must appear verbatim in the text of each span it cites.
  for (const atom of opts.atoms) {
    for (const sid of (atom.source_ids ?? [])) {
      const span = spansById.get(sid);
      if (!span) continue; // unknown spanId — verifyAtomVerbatim already caught this upstream
      if (span.text.indexOf(atom.body) === -1) {
        issues.push({
          code:    'QUOTE_MISMATCH',
          message: `Atom body not found verbatim in span seq ${span.seq} ` +
                   `(spanId "${sid.slice(0, 8)}…"). ` +
                   `Body (first 80 chars): "${atom.body.slice(0, 80)}"`,
          spanSeq: span.seq,
          ruleId:  atom.ruleId,
        });
      }
    }
  }

  // ── Check 2: UNCOVERED_SPAN ────────────────────────────────────────────────
  // Every SourceSpan must be claimed by at least one atom.
  let coveredSpans = 0;
  for (let i = 0; i < opts.spans.length; i++) {
    const sid   = opts.spanIds[i];
    const span  = opts.spans[i];
    const atoms = atomsBySpanId.get(sid) ?? [];
    if (atoms.length > 0) {
      coveredSpans++;
    } else {
      issues.push({
        code:    'UNCOVERED_SPAN',
        message: `Span seq ${span.seq} (spanId "${sid.slice(0, 8)}…") ` +
                 `has no associated atoms — rule text may have been silently dropped.`,
        spanSeq: span.seq,
      });
    }
  }

  // ── Check 3: LOW_DENSITY ───────────────────────────────────────────────────
  // A long span with only one very short atom is suspicious.
  for (let i = 0; i < opts.spans.length; i++) {
    const sid   = opts.spanIds[i];
    const span  = opts.spans[i];
    const atoms = atomsBySpanId.get(sid) ?? [];
    if (
      span.text.length > MIN_COVERED_CHARS &&
      atoms.length === 1 &&
      atoms[0].body.length < MIN_ATOM_BODY_CHARS
    ) {
      issues.push({
        code:    'LOW_DENSITY',
        message: `Span seq ${span.seq} is ${span.text.length} chars but has only ` +
                 `1 atom with a ${atoms[0].body.length}-char body — ` +
                 `AI may have collapsed multiple rules into one.`,
        spanSeq: span.seq,
      });
    }
  }

  // ── Check 4: Page coverage ─────────────────────────────────────────────────
  // Build the set of distinct pages that have at least one span.
  const pagesWithSpans = new Set(
    opts.spans.filter(s => typeof s.page === 'number').map(s => s.page),
  );

  // totalPages: caller override, or highest page seen in spans, or 0 (no page info).
  const totalPages   = opts.totalPages ?? maxPageFromSpans(opts.spans);
  const missingPages = [];

  for (let p = 1; p <= totalPages; p++) {
    if (!pagesWithSpans.has(p)) missingPages.push(p);
  }

  const isComplete = missingPages.length === 0;

  // `ok` = no QUOTE_MISMATCH AND page coverage is complete.
  // UNCOVERED_SPAN and LOW_DENSITY are warnings that do not set ok=false on their own.
  const hasMismatch = issues.some(i => i.code === 'QUOTE_MISMATCH');
  const ok          = !hasMismatch && isComplete;

  return {
    ok,
    isComplete,
    missingPages,
    totalPages,
    coveredPages: pagesWithSpans.size,
    spanCount:    opts.spans.length,
    atomCount:    opts.atoms.length,
    coveredSpans,
    issues,
  };
}
