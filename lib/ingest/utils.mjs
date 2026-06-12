/**
 * lib/ingest/utils.mjs
 *
 * Shared utilities for the ingest pipeline's verbatim guards.
 *
 * The core problem: PDF-extracted text and LLM-returned quotes differ in
 * predictable, non-semantic ways — tab characters, multiple spaces, smart
 * quotes, typographic dashes, and capitalisation.  A strict byte-for-byte
 * indexOf would incorrectly reject these harmless variants.
 *
 * findNormalizedSubstring() solves this by normalising both strings to a
 * canonical form, finding the match in that form, then returning indices
 * that reference the ORIGINAL source string so callers can slice verbatim
 * content without introducing any AI-authored text.
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Canonical single-character normalisation.
 *
 * Only 1-to-1 substitutions are performed here so the position map built
 * by buildNormMap stays valid (each normalised character maps to exactly one
 * character in the original string).
 *
 * Normalised differences excused:
 *   - Typographic quotes → straight ASCII quote characters
 *   - En/em dashes       → hyphen-minus
 *   - Any letter         → lower case
 *
 * @param {string} c  A single character.
 * @returns {string}  Its canonical equivalent.
 */
function normalizeChar(c) {
  switch (c) {
    // LEFT/RIGHT SINGLE QUOTATION MARK → apostrophe
    case '\u2018': case '\u2019': return "'";
    // LEFT/RIGHT DOUBLE QUOTATION MARK → straight double quote
    case '\u201c': case '\u201d': return '"';
    // EN DASH / EM DASH → hyphen-minus
    case '\u2013': case '\u2014': return '-';
    default: return c.toLowerCase();
  }
}

/**
 * Build the normalised form of a string and a parallel position map.
 *
 * Whitespace collapsing: any contiguous run of whitespace (space, tab,
 * newline, etc.) is reduced to a single ASCII space.  Only the first
 * character of each run contributes an entry to the position map.
 *
 * @param {string} s  The string to normalise.
 * @returns {{ normalized: string, map: number[] }}
 *   `normalized` — canonical lowercased/quote-normalised form with
 *                  whitespace collapsed to single spaces.
 *   `map`        — map[i] is the index in `s` of normalized[i].
 */
function buildNormMap(s) {
  const chars = [];
  const map   = [];
  let prevWasSpace = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (!prevWasSpace) {
        chars.push(' ');
        map.push(i);
        prevWasSpace = true;
      }
      // Subsequent whitespace in the same run is skipped; no map entry added.
    } else {
      chars.push(normalizeChar(c));
      map.push(i);
      prevWasSpace = false;
    }
  }

  return { normalized: chars.join(''), map };
}

/**
 * Normalise a string without building a position map.
 *
 * Used for the target (needle) string where we only need the canonical value
 * for comparison — we never need to map positions back into it.
 *
 * @param {string} s
 * @returns {string} Normalised form, leading/trailing whitespace trimmed.
 */
function normalizeString(s) {
  let result = '';
  let prevWasSpace = false;

  for (const c of s) {
    if (/\s/.test(c)) {
      if (!prevWasSpace) {
        result += ' ';
        prevWasSpace = true;
      }
    } else {
      result += normalizeChar(c);
      prevWasSpace = false;
    }
  }

  return result.trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Canonical text form for stable, content-derived key generation.
 *
 * Produces the same normalised string that findNormalizedSubstring uses
 * internally for the target/needle side, making atom_key hashes stable:
 *   - Any whitespace run (space, tab, newline, etc.) → single space
 *   - Typographic quotes → ASCII equivalents  (' ' → '  " " → ")
 *   - En/em dashes → hyphen-minus
 *   - All letters → lowercase
 *   - Leading/trailing whitespace removed
 *
 * Callers should pass the SOURCE-SLICED body (not the AI-authored body)
 * so that the hash reflects the authoritative document text rather than
 * any formatting choices made by the language model.
 *
 * @param {string} text
 * @returns {string} Stable normalised form, suitable for SHA-256 hashing.
 */
export function canonicalizeBody(text) {
  let result = '';
  let prevWasSpace = false;
  for (const c of text) {
    if (/\s/.test(c)) {
      if (!prevWasSpace) {
        result += ' ';
        prevWasSpace = true;
      }
    } else {
      result += normalizeChar(c);
      prevWasSpace = false;
    }
  }
  return result.trim();
}

/**
 * Find `target` within `source`, excusing PDF/LLM formatting artefacts.
 *
 * Differences that are forgiven:
 *   - Extra, missing, or different whitespace (tabs, multiple spaces, newlines)
 *   - Capitalisation differences (all compared lowercase)
 *   - Typographic ("smart") vs. straight quotes
 *   - En/em dashes vs. hyphen-minus
 *
 * Differences that still cause a null return (guard still catches these):
 *   - Added, removed, or substituted words
 *   - Changed sentence structure or meaning
 *
 * The returned indices always reference the ORIGINAL `source` string, so
 * callers can slice the authoritative text without introducing AI-authored
 * content.
 *
 * @param {string} source  The authoritative source text (haystack).
 * @param {string} target  The LLM-returned text to locate (needle).
 * @returns {[number, number] | null}
 *   `[startIndex, endIndex]` (exclusive end) in the original `source`,
 *   or `null` if the target is not found even after normalisation.
 */
export function findNormalizedSubstring(source, target) {
  if (!source || !target) return null;

  const { normalized: normSource, map } = buildNormMap(source);
  const normTarget = normalizeString(target);

  if (!normTarget) return null;

  const idx = normSource.indexOf(normTarget);
  if (idx === -1) return null;

  // Map the normalised match position back to the original string.
  // map[idx] is the original index of the first matched character.
  // map[idx + normTarget.length - 1] is the original index of the last;
  // +1 gives the exclusive end for slicing.
  const origStart = map[idx];
  const origEnd   = map[idx + normTarget.length - 1] + 1;

  return [origStart, origEnd];
}
