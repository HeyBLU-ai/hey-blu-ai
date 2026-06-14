/**
 * Unit checks for evidence fallback threshold logic.
 *   node scripts/test-evidence-fallback.mjs
 */
import {
  bestEvidenceScore,
  shouldUseFallbackRulebook,
  DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
} from '../lib/ingest/evidence-bundle.js';

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('Evidence fallback threshold tests\n');

check('empty bundles score 0', bestEvidenceScore([]) === 0);
check('best score picks max hybrid_score', bestEvidenceScore([
  { hybrid_score: 0.12 },
  { hybrid_score: 0.41 },
]) === 0.41);

check('no bundles triggers fallback', shouldUseFallbackRulebook([]));
check('weak bundles trigger fallback', shouldUseFallbackRulebook([
  { hybrid_score: 0.10 },
  { hybrid_score: 0.18 },
]));
check('strong bundles skip fallback', !shouldUseFallbackRulebook([
  { hybrid_score: 0.55 },
]));
check('threshold boundary is exclusive at default', !shouldUseFallbackRulebook([
  { hybrid_score: DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD },
]));
check('custom threshold respected', shouldUseFallbackRulebook([
  { hybrid_score: 0.40 },
], 0.50));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
