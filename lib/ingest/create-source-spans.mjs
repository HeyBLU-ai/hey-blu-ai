/**
 * lib/ingest/create-source-spans.mjs
 *
 * Persists an array of SourceSpan objects to the `rule_sources` table that
 * was created in RULEBOOK_DB_MIGRATION_V3.sql.
 *
 * Each SourceSpan is tied to a specific rulebook version row
 * (`rulebook_versions.id`) so that edits to a draft do not affect any
 * currently active version.  Source spans are append-only within a version
 * and are never updated — to correct a span, a new draft version is created.
 *
 * Column mapping:
 *   rule_sources.version_id   ← opts.versionId
 *   rule_sources.seq          ← span.seq
 *   rule_sources.heading      ← span.heading
 *   rule_sources.text         ← span.text
 *   rule_sources.page         ← span.page
 *   rule_sources.char_start   ← span.charStart
 *   rule_sources.char_end     ← span.charEnd
 *   rule_sources.source_url   ← span.sourceUrl
 *
 * @typedef {import('./parse-source.mjs').SourceSpan} SourceSpan
 */

/**
 * Insert SourceSpans for a rulebook version into the database.
 *
 * @param {Object}       opts
 * @param {import('pg').Pool} opts.db  - Active pg connection pool.
 * @param {string}       opts.versionId  - UUID of the target `rulebook_versions` row.
 * @param {SourceSpan[]} opts.spans      - Ordered array of parsed SourceSpans.
 * @returns {Promise<{ inserted: number }>}
 * @throws {Error}  If db, versionId, or spans are missing; or if the DB insert fails.
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

  // ── stub — full implementation added in Step 8 ──
  return { inserted: 0 };
}
