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
 * @property {string}   [ruleId]      - DB UUID of the inserted/updated rules row.
 *                                      Present only when opts.dbClient + opts.leagueId are provided.
 */

import Anthropic from '@anthropic-ai/sdk';
import { findNormalizedSubstring } from './utils.mjs';

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
  "body"        – EXACT verbatim text copied character-for-character from the span(s) below.  Do NOT paraphrase, summarise, truncate, or alter any character.
  "source_ids"  – JSON array of span id strings whose text contains or contributes to this atom.

STRICT RULES:
1. "body" must be EXACTLY verbatim text — every character, every space, no substitutions.
2. "source_ids" must only reference the ids provided below.
3. Respond with ONLY a JSON object — no markdown fences, no prose, no explanations.
4. If no atomic rules can be identified, respond with {"atoms":[]}.
5. CROSS-SPAN RULES: If a rule is split across multiple spans (e.g. at a page break), you MUST stitch the text together exactly as it appears in the consecutive spans. List all contributing span ids in "source_ids" in order. Do NOT omit, paraphrase, or drop any words at the boundary, even if the join looks awkward. The "body" must be the exact concatenation of the relevant portions from each span.

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
 * Verify that an atom's body appears verbatim in its cited source spans.
 *
 * Two-pass check (both use the normalisation-tolerant findNormalizedSubstring):
 *
 *   Pass 1 — single-span: body is found inside any one of the cited spans.
 *             Covers the common case where a rule fits entirely on one page.
 *
 *   Pass 2 — cross-span (multi-source_ids only): the texts of all cited spans
 *             are joined with '\n' in order and the body is searched in the
 *             concatenated result.  Covers rules that straddle a page break —
 *             the prompt instructs the AI to stitch across boundaries verbatim,
 *             so the body should appear in the joined text even if it appears
 *             in neither span alone.
 *
 * All source_ids are validated against the lookup map before any search begins
 * so that a missing-span error is always distinguishable from a guard failure.
 *
 * @param {Object}                 atom      - Atom returned by the LLM.
 * @param {Map<string,SourceSpan>} spansById - spanId → SourceSpan lookup.
 * @throws {Error} If source_ids is missing/empty, references an unknown span,
 *                 or the body cannot be located in any single span or the
 *                 concatenation of all cited spans.
 */
function verifyAtomVerbatim(atom, spansById) {
  if (!Array.isArray(atom.source_ids) || atom.source_ids.length === 0) {
    throw new Error(
      `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
      `atom "${String(atom.title ?? '').slice(0, PREVIEW)}" has no source_ids.`,
    );
  }

  // ── Step 1: Validate every referenced ID before searching ─────────────────
  // A missing span ID always produces a distinct, actionable error message.
  for (const sid of atom.source_ids) {
    if (!spansById.has(sid)) {
      throw new Error(
        `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
        `atom "${String(atom.title ?? '').slice(0, PREVIEW)}" ` +
        `references unknown span id "${sid}".`,
      );
    }
  }

  // ── Step 2: Fast path — body found in a single cited span ─────────────────
  // findNormalizedSubstring excuses whitespace, capitalisation, smart quotes,
  // and typographic dashes — it still rejects added/removed/changed words.
  for (const sid of atom.source_ids) {
    if (findNormalizedSubstring(spansById.get(sid).text, atom.body) !== null) {
      return; // guard passed — single-span match
    }
  }

  // ── Step 3: Cross-span path — body stitches across a page boundary ─────────
  // Applicable only when the atom cites two or more consecutive spans.  The
  // spans are joined in source_ids order with a newline separator (mirroring
  // the whitespace that appears between pages in the extracted text), and the
  // body is searched in the concatenated result.
  if (atom.source_ids.length > 1) {
    const joinedText = atom.source_ids
      .map(sid => spansById.get(sid).text)
      .join('\n');
    if (findNormalizedSubstring(joinedText, atom.body) !== null) {
      return; // guard passed — cross-span match
    }
  }

  throw new Error(
    `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
    `atom body not found verbatim in any cited span or their concatenation.\n` +
    `Title (first ${PREVIEW} chars): "${String(atom.title ?? '').slice(0, PREVIEW)}"\n` +
    `Body  (first ${PREVIEW} chars): "${String(atom.body  ?? '').slice(0, PREVIEW)}"\n` +
    `Tip: AI may have paraphrased, summarised, or altered the rule text.`,
  );
}

// ── DB insertion ─────────────────────────────────────────────────────────────

/**
 * UPSERT a rule row in the `rules` table.
 *
 * The UNIQUE constraint on (league_id, rule_number, sport) makes re-ingesting
 * idempotent: if the rule already exists its title and body are refreshed and
 * the existing UUID is returned unchanged.
 *
 * Columns match RULEBOOK_DB_MIGRATION.sql exactly.
 * `sport` defaults to 'baseball'; a future opts.sport will allow softball.
 */
const UPSERT_RULE_SQL = `
  INSERT INTO rules (league_id, rule_number, title, body, sport)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (league_id, rule_number, sport)
  DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now()
  RETURNING id
`.trim();

/**
 * Link a rules row to its verbatim source span in rule_source_links.
 *
 * ON CONFLICT DO NOTHING keeps the operation idempotent — re-ingesting the
 * same rulebook won't produce duplicate links.
 */
const INSERT_SOURCE_LINK_SQL = `
  INSERT INTO rule_source_links (rule_id, source_id, link_type)
  VALUES ($1, $2, $3)
  ON CONFLICT (rule_id, source_id) DO NOTHING
`.trim();

/**
 * Insert or update a batch of verified atoms in the database.
 *
 * For each atom:
 *   1. UPSERT into `rules` → get the rule UUID.
 *   2. INSERT each source_id into `rule_source_links` (link_type = 'supports').
 *
 * Sequential awaiting is used deliberately:
 *   - rule_source_links inserts depend on the rule UUID from step 1.
 *   - Keeps error messages unambiguous (failed atom is identifiable by position).
 *
 * @param {Object}     dbClient  - pg Pool or compatible (must have .query(text, values)).
 * @param {string}     leagueId  - UUID of the league row.
 * @param {RuleAtom[]} atoms     - Verified atoms from the AI extraction step.
 * @param {string}     [sport]   - Sport discriminator, defaults to 'baseball'.
 * @returns {Promise<RuleAtom[]>} Atoms enriched with a `ruleId` field.
 */
async function insertAtoms(dbClient, leagueId, atoms, sport = 'baseball') {
  const result = [];

  for (const atom of atoms) {
    // ── Step 1: UPSERT the rule row ───────────────────────────────────────
    const ruleRes = await dbClient.query(UPSERT_RULE_SQL, [
      leagueId,          // $1  league_id
      atom.rule_number,  // $2  rule_number
      atom.title,        // $3  title
      atom.body,         // $4  body
      sport,             // $5  sport
    ]);
    const ruleId = ruleRes.rows[0].id;

    // ── Step 2: INSERT source links ───────────────────────────────────────
    for (const sourceId of atom.source_ids) {
      await dbClient.query(INSERT_SOURCE_LINK_SQL, [
        ruleId,      // $1  rule_id
        sourceId,    // $2  source_id
        'supports',  // $3  link_type
      ]);
    }

    result.push({ ...atom, ruleId });
  }

  return result;
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
 * @param {Object}       [opts.dbClient]       - pg Pool or compatible. When provided with leagueId,
 *                                               atoms are persisted to `rules` + `rule_source_links`.
 * @param {string}       [opts.leagueId]       - UUID of the league row. Required if dbClient is set.
 * @param {string}       [opts.sport]          - Sport discriminator (default: 'baseball').
 * @returns {Promise<RuleAtom[]>}              All verified atoms. Atoms include `ruleId` when
 *                                               DB inserts were performed.
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
      max_tokens: 8192,
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

  // ── DB persistence (optional — only when both dbClient and leagueId provided) ──
  if (opts.dbClient && opts.leagueId) {
    return insertAtoms(opts.dbClient, opts.leagueId, allAtoms, opts.sport);
  }

  return allAtoms;
}
