/**
 * scripts/test-eval-fixes.mjs
 *
 * Proves the two eval-fix changes are correct without requiring a running server.
 *
 * Fix 1 — Answer prompt wording: inspects buildSpanPrompt output for the new
 *   "use the rulebook's exact language" instruction.
 *
 * Fix 2 — prescreenForMatrix definitional guard: exercises the exported function
 *   directly against known definitional and play-scenario question strings.
 *
 * Usage:
 *   node scripts/test-eval-fixes.mjs
 */

import { prescreenForMatrix } from '../api/judgment-matrices.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? '  —  ' + detail : ''}`);
    failed++;
  }
}

// ── Fix 2: prescreenForMatrix definitional guard ──────────────────────────────

console.log('\nFix 2 — prescreenForMatrix: definitional questions must NOT trigger a matrix\n');

const definitional = [
  'what is the infield fly rule',
  'what is the must slide rule',
  'what is the courtesy runner rule',
  'what is a balk',
  "what's the infield fly rule",
  'explain obstruction',
  'explain the infield fly rule',
  'define interference',
  'describe the appeal rule',
  'what are the base running rules',
  'how does the infield fly work',
  'how do you call obstruction',
  'what does the infield fly rule mean',
  'tell me about the mercy rule',
];

for (const q of definitional) {
  const result = prescreenForMatrix(q);
  check(
    `definitional: "${q}"  → null`,
    result === null,
    `got matrix "${result?.id}"`,
  );
}

console.log('\nFix 2 — prescreenForMatrix: play-scenario questions MUST still trigger a matrix\n');

// NOTE: prescreenForMatrix is a keyword-only shortcut.  Play-scenario questions
// that lack a trigger keyword (e.g. "runner hit the catcher") correctly fall
// through to the LLM classifier — they should return null from prescreen.
// Only questions that contain an explicit trigger keyword are tested here.
const playScenarios = [
  // 'collision' trigger → runner_fielder_collision
  { q: 'there was a collision between the runner and fielder', matrixId: 'runner_fielder_collision' },
  // 'obstruction' trigger → runner_fielder_collision
  { q: 'catcher obstruction at home plate',                   matrixId: 'runner_fielder_collision' },
  // 'infield fly' trigger → infield_fly_rule
  { q: 'infield fly was dropped intentionally',               matrixId: 'infield_fly_rule'         },
  // 'popup' trigger → infield_fly_rule
  { q: 'popup with bases loaded, two outs',                   matrixId: 'infield_fly_rule'         },
  // 'appeal' trigger → appeal_play
  { q: 'runner missed second base on appeal',                 matrixId: 'appeal_play'              },
  // 'force play' trigger → force_vs_tag
  { q: 'is it a force play at third',                         matrixId: 'force_vs_tag'             },
];

for (const t of playScenarios) {
  const result = prescreenForMatrix(t.q);
  check(
    `play scenario: "${t.q}"  → ${t.matrixId}`,
    result !== null && result.id === t.matrixId,
    `got "${result?.id ?? 'null'}" — expected matrix "${t.matrixId}"`,
  );
}

// ── Fix 1: Answer prompt contains conservative wording instruction ────────────
//
// We import buildSpanPrompt indirectly by inspecting the module source to
// confirm the new instruction phrase is present.  This avoids wiring up a
// full mock DB just to call buildSpanPrompt.

console.log('\nFix 1 — Answer prompt: must instruct model to use rulebook\'s exact language\n');

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const askV2Src = readFileSync(resolve(__dirname, '../api/ask-v2.js'), 'utf8');

check(
  'buildSpanPrompt contains "exact language" instruction',
  askV2Src.includes("use the rulebook's exact language"),
);
check(
  'buildSpanPrompt warns against restatement',
  askV2Src.includes('Do NOT restate rules in your own words'),
);
check(
  'buildSpanPrompt instructs verbatim quoting',
  askV2Src.includes('reproduce') && askV2Src.includes('verbatim'),
);
check(
  'buildSpanPrompt instructs anchoring claims to quoted language',
  askV2Src.includes('anchor every factual claim'),
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(56));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(56) + '\n');

if (failed > 0) process.exit(1);
