/**
 * api/verifier.js — Blocking Answer Verifier
 *
 * After the draft answer is generated from source spans, this module runs a
 * second LLM pass (the "verifier") that checks every factual claim in the
 * draft against the verbatim source excerpts that were retrieved.
 *
 * The verifier is FAIL-CLOSED: any parsing failure, API error, or ambiguous
 * result defaults to blocking the response rather than letting it through.
 *
 * Gate logic (what blocks vs. passes):
 *   PASS: status === 'approved'
 *   PASS: status === 'no_rule_found'  (model correctly says no rule found)
 *   PASS: status === 'needs_fact'     (incomplete but not wrong)
 *   BLOCK: status === 'unsupported'
 *   BLOCK: unsupported_claims.length > 0  (regardless of status)
 *   BLOCK: verifier API error         (fail-closed)
 *   BLOCK: verifier JSON parse error  (fail-closed)
 *
 * Verifier output schema (returned by the LLM and re-exported):
 * {
 *   "status":  "approved" | "unsupported" | "needs_fact" | "no_rule_found",
 *   "claims":  [ { "claim": string, "supported": boolean, "source_ids": string[] } ],
 *   "unsupported_claims": string[],
 *   "confidence": "high" | "medium" | "low"
 * }
 */

// ── System prompt ─────────────────────────────────────────────────────────────

export const VERIFIER_SYSTEM_PROMPT = `\
You are a strict fact-checking verifier for a baseball rules Q&A system.

You will receive:
1. A DRAFT ANSWER produced by an AI assistant.
2. ALLOWED SOURCE EXCERPTS — verbatim passages from the official rulebook.

Your task: for every factual claim in the draft answer, determine whether it is
directly and explicitly stated in the provided source excerpts.

CRITICAL RULES:
- Use ONLY the provided source excerpts. Do NOT draw on your own baseball knowledge.
- A claim is "supported" only if a source excerpt explicitly states the same fact.
- Reasonable inferences and implications do NOT count as supported.
- If the draft correctly says "I could not find a specific rule about this", return status "no_rule_found".

Return ONLY valid JSON — no preamble, no markdown:
{
  "status": "approved" | "unsupported" | "needs_fact" | "no_rule_found",
  "claims": [
    {
      "claim": "<exact factual claim from the draft>",
      "supported": true | false,
      "source_ids": ["<uuid of supporting source, or empty array if unsupported>"]
    }
  ],
  "unsupported_claims": ["<verbatim list of unsupported claim texts>"],
  "confidence": "high" | "medium" | "low"
}

Status definitions:
  "approved"      — All claims are directly supported by the source excerpts.
  "unsupported"   — One or more claims are not supported or contradict the sources.
  "needs_fact"    — Answer is correct as far as it goes but requires context not in sources.
  "no_rule_found" — Draft correctly states no applicable rule was found in the rulebook.`;

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the user-turn message for the verifier call.
 *
 * @param {string}   draftAnswer  — The AI-generated draft answer to verify.
 * @param {Object[]} spans        — Source spans returned by fetchSourceSpans.
 *   Each span must have: source_id, exact_text, rule_numbers (optional).
 * @returns {string}
 */
export function buildVerifierPrompt(draftAnswer, spans) {
  const sourceBlock = spans.length === 0
    ? '(No source excerpts were retrieved for this question.)'
    : spans
        .map(s => {
          const ruleRef = (s.rule_numbers ?? '').replace(/,/g, ' /').trim() || 'Unnumbered';
          return `[Source ${s.source_id}]\nRule ${ruleRef}:\n"${s.exact_text}"`;
        })
        .join('\n\n');

  return `DRAFT ANSWER TO VERIFY:
${draftAnswer}

ALLOWED SOURCE EXCERPTS:
${sourceBlock}

Verify every factual claim in the draft answer against the source excerpts above.
Return JSON only.`;
}

// ── Gate predicate ────────────────────────────────────────────────────────────

/**
 * Returns true if the verifier audit result should block the response.
 *
 * Fail-closed: anything other than explicit approval passes the block check.
 *
 * @param {Object} audit — Parsed verifier JSON (or sentinel error object).
 * @returns {boolean}
 */
export function isVerifierBlocked(audit) {
  if (!audit || typeof audit !== 'object') return true;
  if (audit.status === 'unsupported') return true;
  if ((audit.unsupported_claims?.length ?? 0) > 0) return true;
  return false;
}

// ── Core verifier ─────────────────────────────────────────────────────────────

/**
 * Calls the verifier LLM and returns a structured audit object.
 *
 * Errors are caught and converted to a blocking sentinel rather than
 * propagating — the verifier is always fail-closed.
 *
 * @param {Object} opts
 * @param {Object} opts.anthropicClient — Anthropic SDK instance.
 * @param {string} opts.draftAnswer     — Draft answer text to verify.
 * @param {Object[]} opts.spans         — Source spans from fetchSourceSpans.
 * @returns {Promise<Object>}  Verifier audit (may be a synthetic error sentinel).
 */
export async function runVerifier({ anthropicClient, draftAnswer, spans }) {
  const model = process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-opus-4-8';

  // ── 1. Call the verifier LLM ───────────────────────────────────────────────
  let raw = '';
  try {
    const msg = await anthropicClient.messages.create({
      model,
      max_tokens: 1024,
      system:     VERIFIER_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: buildVerifierPrompt(draftAnswer, spans) }],
    });
    raw = msg.content[0]?.text?.trim() ?? '';
  } catch (err) {
    console.warn('[verifier] API call failed (fail-closed):', err.message);
    return {
      status:              'unsupported',
      claims:              [],
      unsupported_claims:  ['verifier_api_error: ' + err.message.slice(0, 120)],
      confidence:          'low',
      _error:              'api_error',
    };
  }

  // ── 2. Parse and validate JSON ─────────────────────────────────────────────
  try {
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object in verifier response');
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));

    const VALID_STATUSES = ['approved', 'unsupported', 'needs_fact', 'no_rule_found'];
    if (!VALID_STATUSES.includes(parsed.status)) {
      throw new Error(`Invalid status value: "${parsed.status}"`);
    }
    if (!Array.isArray(parsed.claims))             parsed.claims             = [];
    if (!Array.isArray(parsed.unsupported_claims)) parsed.unsupported_claims = [];
    if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
      parsed.confidence = 'low';
    }

    return parsed;
  } catch (err) {
    console.warn('[verifier] JSON parse failed (fail-closed):', err.message, '| raw:', raw.slice(0, 300));
    return {
      status:              'unsupported',
      claims:              [],
      unsupported_claims:  ['verifier_parse_error: ' + err.message.slice(0, 120)],
      confidence:          'low',
      _error:              'parse_error',
      _raw_preview:        raw.slice(0, 200),
    };
  }
}
