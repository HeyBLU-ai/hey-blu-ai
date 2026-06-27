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

import { formatEvidenceBundlesForVerifier } from '../lib/ingest/evidence-bundle.js';
import { LLM_VERIFY_MODEL } from '../lib/llm-models.js';

export const VERIFIER_SYSTEM_PROMPT = `\
You are a strict fact-checking verifier for a baseball rules Q&A system.

You will receive:
1. A DRAFT ANSWER produced by an AI assistant.
2. ALLOWED EVIDENCE BUNDLES — canonical rule text from the official rulebook, including ancestor paths and annotations.

Your task: for every factual claim in the draft answer, determine whether it is
directly and explicitly stated in the provided evidence bundles.

CRITICAL RULES:
- Use ONLY the provided evidence bundles. Do NOT draw on your own baseball knowledge.
- A claim is "supported" only if a bundle's canonical text explicitly states the same fact.
- Reasonable inferences and implications do NOT count as supported.
- If the draft correctly says "I could not find a specific rule about this", return status "no_rule_found".
- Verify baseball rule content claims. Do NOT mark citation formatting as unsupported merely because
  a page label, bundle label, or "Official Rule X" display string is not literally part of the quoted
  rule text. Only mark citation details unsupported if the rule number is wrong or the quoted rule
  text is not present in the allowed evidence bundles.

PARTIAL OR INCOMPLETE SOURCE TEXT:
- If the source text partially addresses the question (e.g., acknowledges a rule or category
  exists but does not list every sub-bullet or detail), do NOT mark the answer "unsupported".
- If every claim the draft actually makes is backed by the source text, return "approved" —
  even if the answer is incomplete relative to the full rule.
- If the draft is correct but explicitly notes that details are missing or that the full rule
  could not be found in the retrieved text, return "needs_fact".
- Reserve "unsupported" ONLY for answers that assert or invent facts that are NOT present
  anywhere in the provided evidence bundles, or that directly contradict the bundles.

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
  "approved"      — Every claim in the draft is directly supported by the evidence bundles
                    (answer may be incomplete, but nothing in it is invented or contradicted).
  "unsupported"   — One or more claims invent or assert facts NOT present in the bundles,
                    or directly contradict the bundles. Do NOT use this for partial answers.
  "needs_fact"    — Draft is accurate as far as it goes but explicitly acknowledges that
                    the retrieved text is incomplete or that additional details are missing.
  "no_rule_found" — Draft correctly states no applicable rule was found in the rulebook.`;

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the user-turn message for the verifier call.
 *
 * @param {string}   draftAnswer
 * @param {Object[]} bundles — Evidence bundles from fetchEvidenceBundles.
 * @returns {string}
 */
export function buildVerifierPrompt(draftAnswer, bundles) {
  const sourceBlock = formatEvidenceBundlesForVerifier(bundles);

  return `DRAFT ANSWER TO VERIFY:
${draftAnswer}

ALLOWED EVIDENCE BUNDLES:
${sourceBlock}

Verify every factual claim in the draft answer against the evidence bundles above.
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
 * @param {Object[]} opts.bundles — Evidence bundles from fetchEvidenceBundles.
 * @returns {Promise<Object>}  Verifier audit (may be a synthetic error sentinel).
 */
export async function runVerifier({ anthropicClient, draftAnswer, bundles }) {
  const model = LLM_VERIFY_MODEL;

  // ── 1. Call the verifier LLM ───────────────────────────────────────────────
  let raw = '';
  try {
    const msg = await anthropicClient.messages.create({
      model,
      max_tokens: 2048,
      system:     VERIFIER_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: buildVerifierPrompt(draftAnswer, bundles) }],
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
