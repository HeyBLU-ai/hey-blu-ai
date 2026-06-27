/**
 * HeyBlu LLM model defaults — single source of truth.
 *
 * Production stack (accuracy first, speed second):
 *   Haiku  — routing classifier + offline ingest helpers
 *   Sonnet — answer drafting + verifier gate
 *   Opus   — reserved for future escalation retries (not used on the happy path)
 *
 * Override any tier via env vars in Vercel or .env.local.
 */

export const LLM_FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? 'claude-haiku-4-5';
export const LLM_ANSWER_MODEL = process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6';
export const LLM_VERIFY_MODEL = process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-sonnet-4-6';
export const LLM_ESCALATION_MODEL = process.env.ANTHROPIC_ESCALATION_MODEL ?? 'claude-opus-4-8';

export const LLM_STACK = {
  fast:       LLM_FAST_MODEL,
  answer:     LLM_ANSWER_MODEL,
  verify:     LLM_VERIFY_MODEL,
  escalation: LLM_ESCALATION_MODEL,
};
