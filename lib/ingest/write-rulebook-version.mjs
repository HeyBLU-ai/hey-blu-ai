/**
 * lib/ingest/write-rulebook-version.mjs
 *
 * Two responsibilities (implemented incrementally):
 *
 *   1. createDraftVersion()  ← IMPLEMENTED (Step 12)
 *      Allocates a `rulebook_versions` row (status='draft') and a linked
 *      `rule_documents` row.  Returns { versionId, documentId } so subsequent
 *      pipeline steps can write source spans and rule atoms under these IDs.
 *
 *   2. writeRulebookVersion() ← stub (full orchestration, Step 25)
 *      Will orchestrate the entire write sequence: version + document rows,
 *      source spans, rule atoms, and coverage verification.
 *
 * Activation (status 'draft' → 'active') is a separate, manually-triggered
 * step (Step 12 activate script) to prevent accidental production impact.
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 * @typedef {import('./extract-rule-atoms.mjs').RuleAtom} RuleAtom
 *
 * @typedef {Object} DraftVersionResult
 * @property {string} versionId   - UUID of the new rulebook_versions row.
 * @property {string} documentId  - UUID of the new rule_documents row.
 *
 * @typedef {Object} WriteResult
 * @property {string}  versionId     - UUID of the created/updated draft version row.
 * @property {number}  spansInserted
 * @property {number}  atomsInserted
 * @property {string}  status        - Always `'draft'` after this step.
 */

// ── SQL ───────────────────────────────────────────────────────────────────────

/**
 * Allocate a new draft rulebook_versions row.
 *
 * Columns match RULEBOOK_DB_MIGRATION_V3.sql exactly.
 * status is hardcoded to 'draft' — activation is a separate manual step.
 */
const INSERT_VERSION_SQL = `
  INSERT INTO rulebook_versions (league_id, season, source_hash, status)
  VALUES ($1, $2, $3, 'draft')
  RETURNING id
`.trim();

/**
 * Attach a rule_documents row to the version.
 *
 * The UNIQUE constraint on (league_id, source_hash) blocks re-uploading the
 * same unchanged file.  The caller should check for an existing hash before
 * calling createDraftVersion.
 */
const INSERT_DOCUMENT_SQL = `
  INSERT INTO rule_documents (league_id, version_id, season, source_file, source_hash, mime_type, parse_method)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id
`.trim();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Allocate a new draft rulebook version and its source document row.
 *
 * Performs two sequential INSERTs:
 *   1. rulebook_versions (league_id, season, source_hash, status='draft') → versionId
 *   2. rule_documents (league_id, version_id, season, + documentMeta fields) → documentId
 *
 * The returned { versionId, documentId } pair is passed to createSourceSpans()
 * and extractRuleAtoms() in subsequent pipeline steps.
 *
 * @param {Object}  opts
 * @param {Object}  opts.dbClient         - pg Pool or compatible (must have .query(text, values)).
 * @param {string}  opts.leagueId         - UUID of the target leagues row.
 * @param {string}  [opts.season]         - Season label (e.g. "2026").  Nullable.
 * @param {string}  opts.sourceHash       - SHA-256 hex of the raw source file bytes.
 * @param {Object}  opts.documentMeta     - Source file provenance.
 * @param {string}  opts.documentMeta.source_file   - Original filename (e.g. "rulebook.pdf").
 * @param {string}  [opts.documentMeta.mime_type]   - MIME type (e.g. "application/pdf").
 * @param {string}  opts.documentMeta.parse_method  - Parser used (e.g. "pdf-parse", "mammoth").
 * @returns {Promise<DraftVersionResult>}
 * @throws {Error}  If required opts are missing or the DB write fails.
 */
export async function createDraftVersion(opts = {}) {
  if (!opts.dbClient)    throw new Error('createDraftVersion: opts.dbClient is required.');
  if (!opts.leagueId)    throw new Error('createDraftVersion: opts.leagueId is required.');
  if (!opts.sourceHash)  throw new Error('createDraftVersion: opts.sourceHash is required.');
  if (!opts.documentMeta?.source_file) {
    throw new Error('createDraftVersion: opts.documentMeta.source_file is required.');
  }
  if (!opts.documentMeta?.parse_method) {
    throw new Error('createDraftVersion: opts.documentMeta.parse_method is required.');
  }

  // ── Step 1: INSERT rulebook_versions ─────────────────────────────────────
  const versionRes = await opts.dbClient.query(INSERT_VERSION_SQL, [
    opts.leagueId,        // $1  league_id
    opts.season ?? null,  // $2  season (nullable)
    opts.sourceHash,      // $3  source_hash
  ]);
  const versionId = versionRes.rows[0].id;

  // ── Step 2: INSERT rule_documents ─────────────────────────────────────────
  const docRes = await opts.dbClient.query(INSERT_DOCUMENT_SQL, [
    opts.leagueId,                          // $1  league_id
    versionId,                              // $2  version_id (from step 1)
    opts.season ?? null,                    // $3  season (nullable)
    opts.documentMeta.source_file,          // $4  source_file
    opts.sourceHash,                        // $5  source_hash
    opts.documentMeta.mime_type ?? null,    // $6  mime_type (nullable)
    opts.documentMeta.parse_method,         // $7  parse_method
  ]);
  const documentId = docRes.rows[0].id;

  return { versionId, documentId };
}

/**
 * Write a complete draft rulebook version (spans + atoms) to the database.
 *
 * NOTE: Full orchestration is deferred to Step 25 (unify admin ingest).
 * For now, use createDraftVersion() + createSourceSpans() + extractRuleAtoms()
 * individually in pipeline scripts.
 *
 * @param {Object}       opts
 * @param {import('pg').Pool} opts.db        - Active pg connection pool.
 * @param {string}       opts.leagueId       - UUID of the league row in the `leagues` table.
 * @param {string}       opts.label          - Human-readable version label.
 * @param {string}       opts.sourceFileName - Original file name, stored for provenance.
 * @param {SourceSpan[]} opts.spans          - Parsed source spans.
 * @param {RuleAtom[]}   opts.atoms          - Extracted rule atoms.
 * @returns {Promise<WriteResult>}
 * @throws {Error}  If required opts are missing.
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

  // ── Full orchestration deferred to Step 25 ────────────────────────────────
  return {
    versionId:     '00000000-0000-0000-0000-000000000000',
    spansInserted: 0,
    atomsInserted: 0,
    status:        'draft',
  };
}
