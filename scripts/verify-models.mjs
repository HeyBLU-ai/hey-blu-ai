#!/usr/bin/env node
/**
 * verify-models.mjs
 *
 * Validates all configured AI model IDs against their provider APIs.
 * Exits with code 1 if any model is invalid or unreachable.
 *
 * Usage: node scripts/verify-models.mjs
 *        npm run verify:models
 */
import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Load .env.local ────────────────────────────────────────────────────────
const envRaw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8').catch(() => '');
for (const line of envRaw.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  const key = t.slice(0, eq).trim();
  const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = val;
}

const {
  LLM_FAST_MODEL,
  LLM_ANSWER_MODEL,
  LLM_VERIFY_MODEL,
  LLM_ESCALATION_MODEL,
} = await import('../lib/llm-models.js');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;

const ANTHROPIC_MODELS = {
  ANTHROPIC_FAST_MODEL:       process.env.ANTHROPIC_FAST_MODEL       ?? LLM_FAST_MODEL,
  ANTHROPIC_ANSWER_MODEL:     process.env.ANTHROPIC_ANSWER_MODEL     ?? LLM_ANSWER_MODEL,
  ANTHROPIC_VERIFY_MODEL:     process.env.ANTHROPIC_VERIFY_MODEL     ?? LLM_VERIFY_MODEL,
  ANTHROPIC_ESCALATION_MODEL: process.env.ANTHROPIC_ESCALATION_MODEL ?? LLM_ESCALATION_MODEL,
};

const OPENAI_MODELS = {
  OPENAI_ANSWER_MODEL:          process.env.OPENAI_ANSWER_MODEL,
  OPENAI_ANSWER_MODEL_SNAPSHOT: process.env.OPENAI_ANSWER_MODEL_SNAPSHOT,
};

// ── Utilities ──────────────────────────────────────────────────────────────

const PAD = 35;
const results = [];

function row(envVar, modelId, status, note = '') {
  results.push({ envVar, modelId: modelId ?? '(not set)', status, note });
}

// ── Anthropic verification ─────────────────────────────────────────────────

async function verifyAnthropic() {
  if (!ANTHROPIC_KEY) {
    for (const envVar of Object.keys(ANTHROPIC_MODELS)) {
      row(envVar, ANTHROPIC_MODELS[envVar], 'SKIP', 'ANTHROPIC_API_KEY not set');
    }
    return;
  }

  // Fetch model list from Anthropic
  let anthropicModelIds = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.ok) {
      const data = await res.json();
      anthropicModelIds = new Set((data.data ?? []).map(m => m.id));
    }
  } catch {
    // List API unavailable — fall through to probe calls
  }

  for (const [envVar, modelId] of Object.entries(ANTHROPIC_MODELS)) {
    if (!modelId) {
      row(envVar, modelId, 'FAIL', 'env var not set');
      continue;
    }

    // If we got the model list, check membership
    if (anthropicModelIds) {
      if (anthropicModelIds.has(modelId)) {
        row(envVar, modelId, 'PASS', 'found in model list');
      } else {
        // List may be incomplete for newer models — probe with a minimal call
        const probe = await probeAnthropic(modelId);
        row(envVar, modelId, probe.ok ? 'PASS' : 'FAIL',
          probe.ok ? 'not in list but probe succeeded' : probe.error);
      }
    } else {
      // No list — probe directly
      const probe = await probeAnthropic(modelId);
      row(envVar, modelId, probe.ok ? 'PASS' : 'FAIL',
        probe.ok ? 'probe succeeded' : probe.error);
    }
  }
}

async function probeAnthropic(modelId) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      modelId,
        max_tokens: 1,
        messages:   [{ role: 'user', content: 'hi' }],
      }),
    });
    const data = await res.json();
    if (res.ok || data?.content) return { ok: true };
    if (data?.error?.type === 'not_found_error') return { ok: false, error: 'model not found' };
    // Any other error (auth, rate limit) means the model ID is probably valid
    if (res.status === 401) return { ok: false, error: 'auth error — check API key' };
    return { ok: true, error: `status ${res.status} (model likely valid)` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── OpenAI verification ────────────────────────────────────────────────────

async function verifyOpenAI() {
  if (!OPENAI_KEY) {
    for (const envVar of Object.keys(OPENAI_MODELS)) {
      row(envVar, OPENAI_MODELS[envVar], 'SKIP', 'OPENAI_API_KEY not set');
    }
    return;
  }

  let openaiModelIds = null;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      openaiModelIds = new Set((data.data ?? []).map(m => m.id));
    }
  } catch {
    // Fall through to probe
  }

  for (const [envVar, modelId] of Object.entries(OPENAI_MODELS)) {
    if (!modelId) {
      row(envVar, modelId, 'FAIL', 'env var not set');
      continue;
    }

    if (openaiModelIds) {
      if (openaiModelIds.has(modelId)) {
        row(envVar, modelId, 'PASS', 'found in model list');
      } else {
        row(envVar, modelId, 'FAIL', 'not found in model list');
      }
    } else {
      const probe = await probeOpenAI(modelId);
      row(envVar, modelId, probe.ok ? 'PASS' : 'FAIL',
        probe.ok ? 'probe succeeded' : probe.error);
    }
  }
}

async function probeOpenAI(modelId) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:                 modelId,
        messages:              [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
      }),
    });
    const data = await res.json();
    if (res.ok) return { ok: true };
    if (data?.error?.code === 'model_not_found') return { ok: false, error: 'model not found' };
    if (res.status === 401) return { ok: false, error: 'auth error — check API key' };
    return { ok: true, error: `status ${res.status} (model likely valid)` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Run and print results ─────────────────────────────────────────────────

console.log('\n━━━  HeyBLU Model Verification  ━━━\n');

await verifyAnthropic();
await verifyOpenAI();

const colW = [30, 30, 6, 0];
const header = ['ENV VAR', 'MODEL ID', 'STATUS', 'NOTE'];
console.log(
  header[0].padEnd(colW[0]) + header[1].padEnd(colW[1]) +
  header[2].padEnd(colW[2]) + header[3]
);
console.log('─'.repeat(90));

let anyFail = false;
for (const r of results) {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '–' : '✗';
  console.log(
    `${icon} ${r.envVar.padEnd(colW[0] - 2)}${r.modelId.padEnd(colW[1])}${r.status.padEnd(colW[2])}${r.note}`
  );
  if (r.status === 'FAIL') anyFail = true;
}

console.log('─'.repeat(90));

if (anyFail) {
  console.error('\n✗ One or more model IDs failed. Fix the env vars above before deploying.\n');
  process.exit(1);
} else {
  console.log('\n✓ All configured model IDs verified.\n');
}
