/**
 * lib/ingest/index.mjs
 *
 * Public entry point for the shared ingestion library.
 *
 * Import order reflects the data-flow pipeline:
 *
 *   parseSource()            → SourceSpan[]
 *       ↓
 *   createSourceSpans()      → persists spans, returns DB IDs
 *       ↓
 *   extractRuleAtoms()       → RuleAtom[]
 *       ↓
 *   verifyCoverage()         → CoverageReport  (blocks on QUOTE_MISMATCH)
 *       ↓
 *   writeRulebookVersion()   → WriteResult  (creates draft version row + links)
 *
 * Callers (admin ingest route, local CLI scripts) should import from this
 * file rather than from the individual modules so internal refactors do not
 * require changes in multiple call sites.
 */

export { parseSource }           from './parse-source.mjs';
export { createSourceSpans }     from './create-source-spans.mjs';
export { extractRuleAtoms }      from './extract-rule-atoms.mjs';
export { verifyCoverage }        from './verify-coverage.mjs';
export { writeRulebookVersion }  from './write-rulebook-version.mjs';
