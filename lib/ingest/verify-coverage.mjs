/**
 * lib/ingest/verify-coverage.mjs
 *
 * Deterministic, non-LLM audit that the extracted RuleAtoms and SourceSpans
 * together provide complete, accurate coverage of the original document.
 *
 * Three span-level checks:
 *   QUOTE_MISMATCH  — atom.body must be locatable (via normalised matching) in
 *                     the text of the span(s) it cites.  For atoms that cite one
 *                     span, the body is searched in that span's text.  For atoms
 *                     that cite multiple spans (cross-page rules), the texts are
 *                     concatenated in source_ids order and searched together.
 *                     A mismatch means the AI violated the verbatim contract and
 *                     the data cannot be trusted.
 *   UNCOVERED_SPAN  — every SourceSpan must be claimed by at least one atom.
 *                     Unclaimed spans mean rule text was silently dropped.
 *   LOW_DENSITY     — a long span with only one very short atom is suspicious;
 *                     the AI may have collapsed multi-rule text into a single atom.
 *
 * One page-level check:
 *   Page coverage   — every page that has at least one SourceSpan must also have
 *                     at least one atom citing a span on that page.  This correctly
 *                     ignores blank PDF pages (no span → not in pagesWithSpans) and
 *                     only flags pages where text was extracted but no rules were
 *                     produced.  Documents without page numbers (e.g. DOCX via
 *                     mammoth) are excluded from this check entirely.
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
 * @property {boolean}        isComplete    - true when every page that has a span also
 *                                            has at least one atom citing that span.
 * @property {number[]}       missingPages  - Pages that have text spans but zero extracted atoms.
 * @property {number}         totalPages    - Highest page number seen in spans (or opts.totalPages).
 * @property {number}         coveredPages  - Distinct page numbers that have ≥1 span.
 * @property {number}         spanCount     - Total input spans.
 * @property {number}         atomCount     - Total input atoms.
 * @property {number}         coveredSpans  - Spans claimed by ≥1 atom.
 * @property {CoverageIssue[]} issues       - All detected issues across all checks.
 */

import { findNormalizedSubstring } from './utils.mjs';

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
  // Atom body must be locatable (via normalised matching) in the cited span(s).
  //
  // Single-span atom   → search body in that span's text.
  // Multi-span atom    → concatenate all cited spans' texts in source_ids order
  //                      (mirrors the cross-span stitching instruction given to
  //                       the LLM) and search the joined string.
  //
  // Uses findNormalizedSubstring so that whitespace collapsing, capitalisation
  // shifts, smart quotes, and typographic dashes do not produce false positives.
  // Word-level paraphrasing or insertion still causes a mismatch.
  //
  // One issue is recorded per failing atom (not per failing span link), which
  // keeps the report concise for cross-span atoms.
  for (const atom of opts.atoms) {
    const sids = (atom.source_ids ?? []).filter(sid => spansById.has(sid));
    if (sids.length === 0) continue; // unknown IDs — caught upstream

    let bodyFound;
    if (sids.length === 1) {
      bodyFound = findNormalizedSubstring(spansById.get(sids[0]).text, atom.body) !== null;
    } else {
      const joinedText = sids.map(sid => spansById.get(sid).text).join('\n');
      bodyFound = findNormalizedSubstring(joinedText, atom.body) !== null;
    }

    if (!bodyFound) {
      const firstSpan = spansById.get(sids[0]);
      issues.push({
        code:    'QUOTE_MISMATCH',
        message: `Atom body not found verbatim in cited span(s) ` +
                 `(spanIds: ${sids.map(s => `"${s.slice(0, 8)}…"`).join(', ')}). ` +
                 `Body (first 80 chars): "${atom.body.slice(0, 80)}"`,
        spanSeq: firstSpan.seq,
        ruleId:  atom.ruleId,
      });
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
  // Strategy: only pages that produced at least one SourceSpan are expected to
  // have rule atoms.  Blank PDF pages (no extractable text → no span) are
  // excluded from the check — they correctly have no atoms either.
  //
  // pagesWithSpans: all 1-based page numbers that appear in the span array.
  // pagesWithAtoms: pages where ≥1 atom cites a span on that page.
  // missingPages  : pagesWithSpans \ pagesWithAtoms — the problematic ones.

  const pagesWithSpans = new Set(
    opts.spans.filter(s => typeof s.page === 'number').map(s => s.page),
  );

  const pagesWithAtoms = new Set();
  for (const atom of opts.atoms) {
    for (const sid of (atom.source_ids ?? [])) {
      const span = spansById.get(sid);
      if (span && typeof span.page === 'number') {
        pagesWithAtoms.add(span.page);
      }
    }
  }

  const missingPages = [...pagesWithSpans]
    .filter(p => !pagesWithAtoms.has(p))
    .sort((a, b) => a - b);

  // totalPages: used for reporting only (does not affect missingPages calculation).
  const totalPages = opts.totalPages ?? maxPageFromSpans(opts.spans);
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
