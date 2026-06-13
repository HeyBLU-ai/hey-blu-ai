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

import { createHash }  from 'node:crypto';
import Anthropic       from '@anthropic-ai/sdk';
import { jsonrepair }  from 'jsonrepair';
import { findNormalizedSubstring, canonicalizeBody } from './utils.mjs';

const DEFAULT_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5';

/** Maximum spans per LLM call.  Keeps prompts well inside the context window. */
const BATCH_SIZE = 5;

/** How many chars of body/title to include in error messages. */
const PREVIEW = 120;

// ── Deterministic atom_key derivation ─────────────────────────────────────────

/**
 * Derive a stable, content-based atom key.
 *
 * The key encodes both the official rule number and a 12-hex-char truncation
 * of SHA-256(canonicalBody) so that:
 *
 *   • Two atoms with the same rule_number but different body text produce
 *     different atom_keys and are stored as distinct rows.
 *
 *   • The same rule body always produces the same atom_key, regardless of
 *     batch position, ingest order, or minor AI formatting differences
 *     (whitespace collapsing, case, smart quotes, dashes are all normalised
 *     by canonicalizeBody before hashing).
 *
 *   • Re-ingesting the same rulebook is idempotent: the UPSERT ON CONFLICT
 *     (rulebook_version_id, atom_key, sport) finds the same row and updates
 *     it rather than creating a duplicate.
 *
 * Key format:
 *   Numbered  : "<ruleNumber>#<sha256hex12>"   e.g. "505#a3f2c1d7e9b8"
 *   Unnumbered: "unnumbered#<sha256hex12>"
 *
 * @param {string} ruleNumber  - The official rule number ('' for unnumbered atoms).
 * @param {string} sourceBody  - The source-sliced body text (from sliceAtomBodyFromSource).
 * @returns {string}
 */
export function deriveAtomKey(ruleNumber, sourceBody) {
  const canonical = canonicalizeBody(sourceBody);
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  const prefix = ruleNumber.trim() !== '' ? ruleNumber.trim() : 'unnumbered';
  return `${prefix}#${hash}`;
}

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
 * Scan a span's text for the last explicit rule number (e.g. "405.", "505(a).")
 * so it can be used as a safe, single-line "rearview mirror" hint.
 *
 * Returns the rule number string (e.g. "405") or null if none found.
 * We deliberately do NOT return the full span text — only the number — so the
 * extraction model cannot accidentally use preceding text as atom body material.
 *
 * @param {SourceSpan} span
 * @returns {string|null}
 */
function extractLastRuleNumber(span) {
  if (!span?.text) return null;
  // Match patterns like:  405.  505(a).  4.01.  Section 12.  Rule 505
  // We scan all matches and return the last one found (deepest in the span).
  const pattern = /(?:^|\n)\s*(?:Rule\s+|Section\s+)?(\d{1,4}(?:\.\d{1,2})?(?:\([a-z]\))?)\s*[.\-–]/gim;
  let last = null;
  let m;
  while ((m = pattern.exec(span.text)) !== null) last = m[1];
  return last;
}

/**
 * Construct the extraction prompt for one batch of spans.
 *
 * The prompt:
 *   1. Provides each span as { id, text } so the model can reference IDs.
 *   2. Demands verbatim body text — character-for-character copy from the span.
 *   3. Requests only a JSON object — no markdown, no prose.
 *   4. When a preceding span exists, injects a single "rearview mirror" hint
 *      line showing only the last rule number seen before this batch.  This
 *      tells the model which parent section is "active" without giving it any
 *      text it could accidentally quote in an atom body.
 *
 * @param {SourceSpan[]}    batchSpans
 * @param {string[]}        batchIds
 * @param {SourceSpan|null} [precedingSpan]  The span immediately before this batch.
 * @returns {string}
 */
function buildBatchPrompt(batchSpans, batchIds, precedingSpan = null) {
  const spanEntries = batchSpans
    .map((span, i) => JSON.stringify({ id: batchIds[i], text: span.text }))
    .join(',\n  ');

  // Extract only the rule number from the preceding span (never its full text).
  // This prevents the model from using preceding text as body source material.
  const lastRuleNum = extractLastRuleNumber(precedingSpan);
  const inheritanceHint = lastRuleNum
    ? `\nACTIVE PARENT RULE (from preceding section, for Rule Number Inheritance ONLY): ${lastRuleNum}\n`
    : '';

  return `You are a baseball rulebook parser.  Extract every atomic rule from the source spans below.

An "atomic rule" is the smallest independently applicable unit: one obligation, permission, prohibition, or procedure that can be cited on its own.

For each atom return exactly these fields:
  "rule_number" – the official rule identifier (e.g. "505", "4.01", "505(a)"). Use "" if none is stated.
  "title"       – one-line descriptor, ≤120 characters.
  "body"        – EXACT verbatim text copied character-for-character from the span(s) below.  Do NOT paraphrase, summarise, truncate, or alter any character.
  "source_ids"  – JSON array of span id strings whose text contains or contributes to this atom.

STRICT RULES:
1. "body" must be EXACTLY verbatim text — every character, every space, no substitutions.
2. "source_ids" must only reference the ids listed in the SOURCE SPANS below.
3. Respond with ONLY a JSON object — no markdown fences, no prose, no explanations.
4. If no atomic rules can be identified, respond with {"atoms":[]}.
5. CROSS-SPAN RULES: If a rule is split across multiple spans (e.g. at a page break), you MUST stitch the text together exactly as it appears in the consecutive spans. List all contributing span ids in "source_ids" in order. Do NOT omit, paraphrase, or drop any words at the boundary, even if the join looks awkward. The "body" must be the exact concatenation of the relevant portions from each span.
6. RULE NUMBER INHERITANCE: If a span begins with a sub-clause, lettered list item (A, B, C, …), or numbered bullet (1, 2, 3, …) without an explicit rule number, use the ACTIVE PARENT RULE hint (shown above the source spans, when present) as the "rule_number" for that atom. Do NOT leave "rule_number" empty for sub-clauses that clearly continue a numbered parent section. Example: if ACTIVE PARENT RULE is "405" and a span begins with "C. Mercy Rules", that atom's "rule_number" MUST be "405".
${inheritanceHint}
Required format:
{"atoms":[{"rule_number":"405","title":"Mercy Rules (sub-clause C of Rule 405)","body":"exact verbatim text here","source_ids":["span-id-here"]}]}

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
  // Pass 1: whitespace control chars (tab, CR, LF) → single space.
  // Pass 2: remaining non-whitespace control chars → \\uXXXX escape.
  const sanitized = raw.slice(start, end + 1)
    .replace(/\t|\r\n|\r|\n/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    )
    .trim();

  // Fast path: well-formed JSON.
  try {
    return JSON.parse(sanitized);
  } catch (_) { /* fall through to repair */ }

  // Repair path: handles unescaped quotes, trailing commas, missing brackets,
  // and other common LLM formatting mistakes.  If this also fails the caller
  // will catch and re-throw with a diagnostic.
  return JSON.parse(jsonrepair(sanitized));
}

/**
 * Verify that an atom's body appears verbatim in its cited source spans, and
 * return the canonical body text sliced from the ORIGINAL source.
 *
 * Two-pass check (both use the normalisation-tolerant findNormalizedSubstring):
 *
 *   Pass 1 — single-span: body is found inside any one of the cited spans.
 *             Returns the slice of that span's original text.
 *
 *   Pass 2 — cross-span (multi-source_ids only): the texts of all cited spans
 *             are joined with '\n' in order and the body is searched in the
 *             concatenated result.  Returns the slice of the joined text.
 *
 * IMPORTANT: The returned string is ALWAYS sliced from the original source
 * text, never from the AI response.  Callers must store the return value as
 * the atom's body rather than atom.body directly.  This ensures:
 *   - Capitalisation differences are corrected to the source's casing.
 *   - Whitespace variants (smart quotes, extra spaces) match the source.
 *   - No AI-authored text enters the database.
 *
 * All source_ids are validated against the lookup map before any search begins
 * so that a missing-span error is always distinguishable from a guard failure.
 *
 * @param {Object}                 atom      - Atom returned by the LLM.
 * @param {Map<string,SourceSpan>} spansById - spanId → SourceSpan lookup.
 * @returns {string} The canonical body text sliced from the original source.
 * @throws {Error} If source_ids is missing/empty, references an unknown span,
 *                 or the body cannot be located in any single span or the
 *                 concatenation of all cited spans.
 */
function sliceAtomBodyFromSource(atom, spansById) {
  if (!Array.isArray(atom.source_ids) || atom.source_ids.length === 0) {
    throw new Error(
      `extractRuleAtoms: VERBATIM GUARD FAILED — ` +
      `atom "${String(atom.title ?? '').slice(0, PREVIEW)}" has no source_ids.`,
    );
  }

  // ── Step 1: Validate every referenced ID before searching ─────────────────
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
    const span  = spansById.get(sid);
    const range = findNormalizedSubstring(span.text, atom.body);
    if (range !== null) {
      // Return slice from the ORIGINAL source, not from the AI response.
      return span.text.slice(range[0], range[1]);
    }
  }

  // ── Step 3: Cross-span path — body stitches across a page boundary ─────────
  if (atom.source_ids.length > 1) {
    const joinedText = atom.source_ids
      .map(sid => spansById.get(sid).text)
      .join('\n');
    const range = findNormalizedSubstring(joinedText, atom.body);
    if (range !== null) {
      // Return slice from the joined ORIGINAL text.
      return joinedText.slice(range[0], range[1]);
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
 * The UNIQUE constraint targets (rulebook_version_id, atom_key, sport).
 * atom_key is content-derived (see deriveAtomKey): same body → same key, so
 * re-ingesting the same rulebook is fully idempotent.  Different bodies sharing
 * the same rule_number produce different atom_keys and coexist as distinct rows.
 *
 * Columns: atom_key ($3) is the unique conflict key; rule_number ($4) is the
 * human-readable official number stored for display and FTS search.
 *
 * Requires migrate-v3-atom-key.mjs to have been run first.
 */
const UPSERT_RULE_SQL = `
  INSERT INTO rules (league_id, rulebook_version_id, atom_key, rule_number, title, body, sport)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (rulebook_version_id, atom_key, sport)
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
 * Each atom in `atoms` already carries a pre-computed `atomKey` (set by
 * extractRuleAtoms before this function is called) so insertAtoms is a
 * straight write loop with no sequencing or counter logic.
 *
 * For each atom:
 *   1. UPSERT into `rules` using atom.atomKey as the conflict key.
 *   2. INSERT each source_id into `rule_source_links` (link_type = 'supports').
 *
 * Sequential awaiting keeps error messages unambiguous.
 *
 * @param {Object}     dbClient   - pg Pool or compatible (.query(text, values)).
 * @param {string}     leagueId   - UUID of the league row.
 * @param {string}     versionId  - UUID of the rulebook_versions row.
 * @param {RuleAtom[]} atoms      - Verified atoms with pre-computed atomKey.
 * @param {string}     [sport]    - Sport discriminator, defaults to 'baseball'.
 * @returns {Promise<RuleAtom[]>} Atoms enriched with a `ruleId` field.
 */
async function insertAtoms(dbClient, leagueId, versionId, atoms, sport = 'baseball') {
  const result = [];

  for (const atom of atoms) {
    // atomKey is content-derived and always present on the atom object.
    const { atomKey, rule_number, title, body, source_ids } = atom;

    // ── UPSERT the rule row ───────────────────────────────────────────────
    const ruleRes = await dbClient.query(UPSERT_RULE_SQL, [
      leagueId,     // $1  league_id
      versionId,    // $2  rulebook_version_id
      atomKey,      // $3  atom_key  (content-derived unique conflict key)
      rule_number,  // $4  rule_number (official display number, '' for unnumbered)
      title,        // $5  title
      body,         // $6  body (source-sliced)
      sport,        // $7  sport
    ]);
    const ruleId = ruleRes.rows[0].id;

    // ── INSERT source links ───────────────────────────────────────────────
    for (const sourceId of source_ids) {
      await dbClient.query(INSERT_SOURCE_LINK_SQL, [ruleId, sourceId, 'supports']);
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
 * @param {Object}       [opts.dbClient]       - pg Pool or compatible. When provided with leagueId
 *                                               and versionId, atoms are persisted to `rules` +
 *                                               `rule_source_links`.
 * @param {string}       [opts.leagueId]       - UUID of the league row. Required if dbClient is set.
 * @param {string}       [opts.versionId]      - UUID of the rulebook_versions row. Required if
 *                                               dbClient is set. Scopes the UPSERT conflict target
 *                                               to prevent cross-version rule squashing.
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

    // ── Rearview mirror ────────────────────────────────────────────────────────
    // Pass the span immediately preceding this batch as read-only context so
    // the model can resolve rule number inheritance when the batch begins with
    // a sub-clause (A, B, C…) whose parent heading appeared in the prior batch.
    const precedingSpan = bStart > 0 ? opts.spans[bStart - 1] : null;

    const prompt = buildBatchPrompt(batchSpans, batchIds, precedingSpan);

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
        `Raw response (first 1000 chars): "${raw.slice(0, 1000)}"`,
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

      // ── VERBATIM GUARD + SOURCE SLICE ─────────────────────────────────────
      // sliceAtomBodyFromSource validates that the AI's body can be located in
      // the cited source spans and returns the text sliced from the ORIGINAL
      // source — never from the AI response.  This ensures that AI casing,
      // smart-quote, or whitespace variants do not enter the database.
      const canonicalBody = sliceAtomBodyFromSource(atom, spansById);
      const ruleNumber    = String(atom.rule_number ?? '');

      // ── CONTENT-DERIVED atom_key ───────────────────────────────────────────
      // Always computed here (not deferred to insertAtoms) so atomKey is
      // available in the memory-only return path too, and so stability tests
      // can verify it without a real DB connection.
      const atomKey = deriveAtomKey(ruleNumber, canonicalBody);

      allAtoms.push({
        sourceSpanId: atom.source_ids[0],
        source_ids:   atom.source_ids,
        rule_number:  ruleNumber,
        title:        String(atom.title ?? ''),
        body:         canonicalBody,
        atomKey,
      });
    }
  }

  // ── DB persistence (optional — only when dbClient + leagueId + versionId provided) ──
  if (opts.dbClient && opts.leagueId && opts.versionId) {
    return insertAtoms(opts.dbClient, opts.leagueId, opts.versionId, allAtoms, opts.sport);
  }

  return allAtoms;
}
