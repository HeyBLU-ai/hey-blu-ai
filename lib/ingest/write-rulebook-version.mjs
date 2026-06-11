/**
 * lib/ingest/write-rulebook-version.mjs
 *
 * Creates or updates a `rulebook_versions` row and orchestrates the full
 * DB write sequence for a new ingestion:
 *
 *   1. Upsert a `rulebook_versions` row in `draft` status.
 *   2. Delete any existing rule_sources rows for that version (idempotent re-run).
 *   3. Bulk-insert the SourceSpans via createSourceSpans().
 *   4. Bulk-insert the RuleAtoms into `rule_documents` + `rule_source_links`.
 *   5. Return the version ID and row counts so the caller can run
 *      coverage verification before deciding whether to activate.
 *
 * Activation (changing status from `draft` → `active`) is a separate,
 * manually-triggered step (Step 12) to prevent accidental production impact.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 * @typedef {import('./extract-rule-atoms.mjs').RuleAtom} RuleAtom
 *
 * @typedef {Object} WriteResult
 * @property {string}  versionId     - UUID of the created/updated draft version row.
 * @property {number}  spansInserted
 * @property {number}  atomsInserted
 * @property {string}  status        - Always `'draft'` after this step.
 */

/**
 * Write a complete draft rulebook version (spans + atoms) to the database.
 *
 * @param {Object}       opts
 * @param {import('pg').Pool} opts.db        - Active pg connection pool.
 * @param {string}       opts.leagueId       - UUID of the league row in the `leagues` table.
 * @param {string}       opts.label          - Human-readable version label (e.g. "2026 Season Rules").
 * @param {string}       opts.sourceFileName - Original file name, stored for provenance.
 * @param {SourceSpan[]} opts.spans          - Parsed source spans.
 * @param {RuleAtom[]}   opts.atoms          - Extracted rule atoms.
 * @returns {Promise<WriteResult>}
 * @throws {Error}  If required opts are missing, or if the DB transaction fails.
 */
export async function writeRulebookVersion(opts = {}) {
  if (!opts.db)             throw new Error('writeRulebookVersion: opts.db (pg Pool) is required.');
  if (!opts.leagueId)       throw new Error('writeRulebookVersion: opts.leagueId is required.');
  if (!opts.label)          throw new Error('writeRulebookVersion: opts.label is required.');
  if (!opts.sourceFileName) throw new Error('writeRulebookVersion: opts.sourceFileName is required.');
  if (!Array.isArray(opts.spans) || opts.spans.length === 0) {
    throw new Error('writeRulebookVersion: opts.spans must be a non-empty array.');
  }
  if (!Array.isArray(opts.atoms)) {
    throw new Error('writeRulebookVersion: opts.atoms must be an array (may be empty before atom extraction).');
  }

  // ── stub — full implementation added in Step 8 ──
  return {
    versionId:     '00000000-0000-0000-0000-000000000000',
    spansInserted: 0,
    atomsInserted: 0,
    status:        'draft',
  };
}
