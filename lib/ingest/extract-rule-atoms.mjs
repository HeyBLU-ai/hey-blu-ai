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
 * Scan a span's text for the last explicit rule number header
 * (e.g. "405.", "532.", "4.01.", "Rule 505").
 *
 * Used by the sticky tracker to detect when a span starts a new top-level
 * rule section.  Returns only the rule number string (e.g. "405") or null.
 * We never return the full span text to avoid giving the model quotable
 * source material outside the batch's source_ids.
 *
 * @param {SourceSpan|null} span
 * @returns {string|null}
 */
function extractLastRuleNumber(span) {
  if (!span?.text) return null;
  // Match patterns like:  405.  532(a).  4.01.  Rule 505  Section 12.
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
 *   4. When stickyRuleNumber is set (non-empty), injects a hard STICKY CONTEXT
 *      directive telling the model exactly which parent rule is currently active.
 *      This is computed by the stateful tracker in extractRuleAtoms and is far
 *      more reliable than a one-batch lookahead because it persists across the
 *      entire document.
 *
 * @param {SourceSpan[]} batchSpans
 * @param {string[]}     batchIds
 * @param {string}       [stickyRuleNumber='']  Active parent rule from the sticky tracker.
 * @returns {string}
 */
function buildBatchPrompt(batchSpans, batchIds, stickyRuleNumber = '') {
  const spanEntries = batchSpans
    .map((span, i) => JSON.stringify({ id: batchIds[i], text: span.text }))
    .join(',\n  ');

  // Sticky context: injected before the source spans when a parent rule is active.
  //
  // CRITICAL: this hint is for TRULY AMBIGUOUS spans only (sub-clauses without
  // their own rule number).  It MUST NOT override a span that already begins
  // with an explicit "NNN." or "NNN. Title" header.  The model is instructed
  // to detect and honour explicit headers first.
  const stickyBlock = stickyRuleNumber
    ? `\nSTICKY CONTEXT — sub-clauses only: The spans below may include lettered items (A, B, C, …) or numbered bullets (1, 2, 3, …) that belong to parent rule "${stickyRuleNumber}". Assign rule_number "${stickyRuleNumber}" ONLY to spans that have NO top-level rule number of their own. If a span starts with an explicit rule header of the form "NNN." or "NNN. Title" (e.g. "100. Membership", "405. Length of Game"), you MUST use that explicit number as rule_number — the STICKY CONTEXT does not apply to it.\n`
    : '';

  return `You are a baseball rulebook parser.  Extract every atomic rule from the source spans below.

An "atomic rule" is the smallest independently applicable unit: one obligation, permission, prohibition, or procedure that can be cited on its own.

For each atom return exactly these fields:
  "rule_number" – the official rule identifier (e.g. "505", "4.01", "505(a)"). Use "" ONLY if the text cannot be attributed to any known rule number.
  "title"       – one-line descriptor, ≤120 characters.
  "body"        – EXACT verbatim text copied character-for-character from the span(s) below.  Do NOT paraphrase, summarise, truncate, or alter any character.
  "source_ids"  – JSON array of span id strings whose text contains or contributes to this atom.
${stickyBlock}
STRICT RULES:
1. "body" must be EXACTLY verbatim text — every character, every space, no substitutions.
2. "source_ids" must only reference the ids listed in the SOURCE SPANS below.
3. Respond with ONLY a JSON object — no markdown fences, no prose, no explanations.
4. If no atomic rules can be identified, respond with {"atoms":[]}.
5. CROSS-SPAN RULES: If a rule is split across multiple spans (e.g. at a page break), you MUST stitch the text together exactly as it appears in the consecutive spans. List all contributing span ids in "source_ids" in order. Do NOT omit, paraphrase, or drop any words at the boundary, even if the join looks awkward. The "body" must be the exact concatenation of the relevant portions from each span.
6. RULE NUMBER INHERITANCE: If a span begins with a sub-clause, lettered list item (A, B, C, …), or numbered bullet (1, 2, 3, …) without its own top-level rule number, inherit the parent rule number from the STICKY CONTEXT above (when present). Only use "" when the text is genuinely introductory prose that cannot be attributed to any rule.

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

  // ── Pre-classify TOC pages ────────────────────────────────────────────────
  // Pages where the average sub-span length is very small (< 50 chars) are
  // table-of-contents or index pages.  They contain one rule title per span
  // (e.g. "100. Membership") with no rule body.  If we let the sticky tracker
  // update from these pages it locks onto the LAST rule in the TOC (e.g. "620")
  // and that number bleeds into every subsequent body page.
  //
  // Strategy: compute average sub-span length per page before the main loop,
  // flag short-average pages as TOC pages, and skip Phase-1 / Phase-2 tracker
  // updates for any span whose page_start is in that set.
  const _pageGroups = new Map();   // page → [spanLength, …]
  for (const span of opts.spans) {
    // Sub-spans use `.page` (the page number from the source PDF).
    // Fall back to -1 (a sentinel that won't match any real page) when unset.
    const p = span.page ?? -1;
    if (!_pageGroups.has(p)) _pageGroups.set(p, []);
    _pageGroups.get(p).push(span.text?.trim().length ?? 0);
  }
  const tocPages = new Set();
  for (const [page, lengths] of _pageGroups) {
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (avg < 50) tocPages.add(page);   // below threshold → TOC / intro page
  }
  if (tocPages.size > 0) {
    const sorted = [...tocPages].sort((a, b) => a - b);
    console.error(`  ℹ TOC-page guard active — skipping tracker updates for page(s): ${sorted.join(', ')}`);
  }

  // ── Sticky rule-number tracker ────────────────────────────────────────────
  // Persists the "currently active" parent rule number across the entire
  // document.  Updated after each batch via two phases:
  //
  //   Phase 1 — regex scan of span texts for explicit "NNN." headers.
  //             Skips spans on tocPages to prevent TOC entries from polluting
  //             the tracker (a TOC lists all rules; the last one wins otherwise).
  //
  //   Phase 2 — AI's returned rule_number for top-level rule declarations.
  //             A top-level declaration is one whose body begins with the rule
  //             number itself (e.g. "100. Membership …").  Sub-clauses whose
  //             rule_number was inherited (body starts with prose, not a number)
  //             are excluded so they don't "confirm" a wrong sticky value.
  //             Also skips atoms sourced from tocPages.
  //
  // The value at the START of each batch is injected into the prompt as the
  // STICKY CONTEXT hint, which the model applies only to spans without their
  // own explicit top-level rule number.
  let currentActiveRuleNumber = '';

  // Process in batches
  for (let bStart = 0; bStart < opts.spans.length; bStart += batchSize) {
    const batchSpans = opts.spans.slice(bStart, bStart + batchSize);
    const batchIds   = opts.spanIds.slice(bStart, bStart + batchSize);

    // Snapshot: active rule number BEFORE this batch (what sub-clauses at the
    // very start of the batch should inherit from the previous section).
    const stickyForThisBatch = currentActiveRuleNumber;

    // Track how many atoms existed before this batch so the post-batch
    // tracker sync knows which atoms are new.
    const atomCountBefore = allAtoms.length;

    const prompt = buildBatchPrompt(batchSpans, batchIds, stickyForThisBatch);

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

    // ── Update sticky tracker after each batch (two-phase) ───────────────────
    //
    // Phase 1 — regex scan of span texts for explicit "NNN." rule headers.
    //   Skips spans whose page_start is in tocPages so that table-of-contents
    //   entries (which end with the last rule number in the document, e.g. "620")
    //   cannot pollute the tracker for the rest of the document.
    for (const span of batchSpans) {
      if (tocPages.has(span.page ?? -1)) continue;   // skip TOC / intro pages
      const headerNum = extractLastRuleNumber(span);
      if (headerNum) currentActiveRuleNumber = headerNum;
    }

    // Phase 2 — sync with the AI's actual findings, but ONLY for atoms that are
    //   top-level rule declarations (body begins with the rule number itself,
    //   e.g. "532. Un-Sportsmanlike Conduct …").  Sub-clauses whose rule_number
    //   was inherited (body starts with prose like "The Board has a duty…") are
    //   excluded so they cannot reinforce a wrong sticky value.
    //   Also skips atoms sourced from tocPages.
    const topLevelDeclPattern = /^\s*\d{1,4}(?:\.\d{1,2})?(?:\([a-z]\))?\s*[.\-–]/i;
    for (const atom of allAtoms.slice(atomCountBefore)) {
      if (!atom.rule_number || atom.rule_number.trim() === '') continue;
      // Skip if the atom's source span is on a TOC page
      const primarySpan = spansById.get(atom.sourceSpanId);
      if (primarySpan && tocPages.has(primarySpan.page ?? -1)) continue;
      // Skip if the body doesn't start with the rule number (inherited sub-clause)
      if (!topLevelDeclPattern.test(atom.body)) continue;
      currentActiveRuleNumber = atom.rule_number;
    }
  }

  // ── Deterministic rule-number inheritance (post-processing) ──────────────
  // The AI's sticky-context hint improves intra-batch attribution, but is not
  // 100% reliable for sub-clauses that span multiple batches or that the model
  // classifies as "prose" rather than a sub-clause.
  //
  // This pass is the authoritative backstop:
  //   • Walk allAtoms in document order (batch order = source span order).
  //   • Track the last atom whose rule_number is non-empty AND whose source
  //     span is NOT on a TOC page (we never want a TOC entry like
  //     "620. Playoff Game Limits" to cascade into the body).
  //   • Assign that rule number to any atom with rule_number = "".
  //   • Re-derive the atom_key so the UPSERT target stays stable.
  //
  // Result: every body sub-clause inherits the rule number of the nearest
  // preceding rule header in the document, deterministically and without
  // any AI involvement.
  {
    let lastBodyRuleNumber = '';
    for (const atom of allAtoms) {
      // Determine if this atom's primary source span is on a TOC page.
      const primarySpan = spansById.get(atom.sourceSpanId);
      const isOnTocPage = primarySpan && tocPages.has(primarySpan.page ?? -1);

      if (atom.rule_number.trim() !== '') {
        // Update lastBodyRuleNumber only from body (non-TOC) atoms so that
        // a TOC entry like "620. Playoff Game Limits" does not pollute
        // inheritance for the rest of the document.
        if (!isOnTocPage) lastBodyRuleNumber = atom.rule_number;
      } else if (lastBodyRuleNumber && !isOnTocPage) {
        // Inherit: give this unnumbered body atom its parent's rule number.
        atom.rule_number = lastBodyRuleNumber;
        atom.atomKey     = deriveAtomKey(lastBodyRuleNumber, atom.body);
      }
    }

    const numberedAfter   = allAtoms.filter(a => a.rule_number.trim() !== '').length;
    const unnumberedAfter = allAtoms.length - numberedAfter;
    console.error(
      `  ℹ Post-processing inheritance: ${numberedAfter} numbered, ${unnumberedAfter} unnumbered`,
    );
  }

  // ── DB persistence (optional — only when dbClient + leagueId + versionId provided) ──
  if (opts.dbClient && opts.leagueId && opts.versionId) {
    return insertAtoms(opts.dbClient, opts.leagueId, opts.versionId, allAtoms, opts.sport);
  }

  return allAtoms;
}
