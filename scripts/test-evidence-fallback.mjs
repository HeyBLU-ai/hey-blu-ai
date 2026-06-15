/**
 * Unit checks for evidence fallback threshold logic.
 *   node scripts/test-evidence-fallback.mjs
 */
import {
  bestEvidenceScore,
  shouldUseFallbackRulebook,
  computeHybridScore,
  mergeDualPathChunkHits,
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

console.log('\nDual-path merge tests\n');

const merged = mergeDualPathChunkHits(
  [{ chunk_id: 'a', rule_number: '430', vector_score: 0.68, strict_fts_score: 0.66, or_fts_score: 0.66 }],
  [{ chunk_id: 'b', rule_number: '432', vector_score: 0.49, strict_fts_score: 0.38, or_fts_score: 0.38 }],
  'courtesy runner rule',
);
check('merge returns union of both paths', merged.length === 2);
check('top merged hit is vector leader', merged[0].chunk_id === 'a');
check('fts-only chunk still ranked', merged.some((h) => h.chunk_id === 'b'));

const dual = mergeDualPathChunkHits(
  [{ chunk_id: 'x', rule_number: '430', vector_score: 0.5, strict_fts_score: 0.1, or_fts_score: 0.1 }],
  [{ chunk_id: 'x', rule_number: '430', vector_score: 0.5, strict_fts_score: 0.8, or_fts_score: 0.8 }],
  'courtesy runner rule',
);
check('dual-path hit uses max fts score', Number(dual[0].hybrid_score) > computeHybridScore(0.5, 0.1, 0.1, 'courtesy runner rule', '430'));
check('dual-path hit tagged vector+fts', dual[0].retrieval_paths.includes('vector') && dual[0].retrieval_paths.includes('fts'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
