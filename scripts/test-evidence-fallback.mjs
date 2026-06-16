/**
 * Unit checks for evidence fallback threshold logic.
 *   node scripts/test-evidence-fallback.mjs
 */
import {
  bestEvidenceScore,
  shouldUseFallbackRulebook,
  computeHybridScore,
  mergeDualPathChunkHits,
  questionReferencesRuleNumber,
  topScoringBundle,
  bundleHasPhraseCoverage,
  extractQueryPhrases,
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

console.log('\nRule-number boost tests\n');

check('10U does not boost rule 10', !questionReferencesRuleNumber('10U division rules', '10'));
check('10-run does not boost rule 10', !questionReferencesRuleNumber('10-run rule applies', '10'));
check('10-year-old does not boost rule 10', !questionReferencesRuleNumber('player is 10-year-old', '10'));
check('3 outs does not boost rule 3', !questionReferencesRuleNumber('with 3 outs remaining', '3'));
check('rule 3 boosts rule 3', questionReferencesRuleNumber('what does rule 3 say', '3'));
check('section 430 boosts rule 430', questionReferencesRuleNumber('see section 430 for courtesy runner', '430'));
check('rule 430 boosts rule 430', questionReferencesRuleNumber('courtesy runner rule 430', '430'));
check('bare 430 does not boost', !questionReferencesRuleNumber('courtesy runner 430 details', '430'));
check('1.10 anchored boost', questionReferencesRuleNumber('explain rule 1.10 bat rules', '1.10'));
check('PR-5 local rule boost', questionReferencesRuleNumber('what is PR-5 about', 'PR-5'));
check('no boost for substring 430 in 1430', !questionReferencesRuleNumber('section 1430 details', '430'));
check('computeHybridScore skips false 10U boost',
  computeHybridScore(0.5, 0.1, 0.1, '10U baseball', '10') === 0.5 * 0.75 + 0.1 * 0.25);

console.log('\nSingle-token fallback tests\n');

check('obstruction single-word triggers fallback', shouldUseFallbackRulebook(
  [{ hybrid_score: 0.45, title: 'Local', matched_chunk_text: 'unrelated text' }],
  0.30,
  'Obstruction?',
));
check('extractQueryPhrases empty for single token', extractQueryPhrases('Obstruction?').length === 0);

console.log('\nPhrase-gating tests (top bundle only)\n');

const localBundles = [
  { hybrid_score: 0.45, title: 'After Every Game', matched_chunk_text: 'drag the infield dirt' },
  { hybrid_score: 0.30, title: 'PR-5', matched_chunk_text: 'there is no infield fly rule in aaa' },
];
check('fallback when top bundle lacks phrase', shouldUseFallbackRulebook(localBundles, 0.30, 'infield fly'));
check('top bundle identified correctly', topScoringBundle(localBundles).title === 'After Every Game');
check('secondary bundle phrase ignored', !bundleHasPhraseCoverage(topScoringBundle(localBundles), extractQueryPhrases('infield fly')));

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
