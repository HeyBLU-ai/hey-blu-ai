#!/usr/bin/env node
/**
 * Unit checks for DOCX ingest hardening (bounds + auth ordering).
 *   node scripts/test-docx-ingest-hardening.mjs
 */
import { assertDocxGraphBounds, DOCX_PARSE_LIMITS } from '../lib/ingest/docx-pipeline.mjs';

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${label}`);
    failed += 1;
  }
}

function expectThrow(label, fn, includes) {
  try {
    fn();
    check(label, false);
  } catch (err) {
    check(label, String(err.message).includes(includes));
  }
}

const baseGraph = {
  markdown: 'x'.repeat(100),
  sections: [{ title: 'A', body_text: 'x' }],
  nodes: [{ node_key: 'a' }],
  chunks: [{ node_key: 'a', chunk_index: 0, chunk_text: 'x' }],
};

check('accepts graph within bounds', (() => {
  assertDocxGraphBounds(baseGraph);
  return true;
})());

expectThrow(
  'rejects oversized markdown',
  () => assertDocxGraphBounds({
    ...baseGraph,
    markdown: 'x'.repeat(DOCX_PARSE_LIMITS.maxMarkdownChars + 1),
  }),
  `${DOCX_PARSE_LIMITS.maxMarkdownChars.toLocaleString()}`,
);

expectThrow(
  'rejects too many nodes',
  () => assertDocxGraphBounds({
    ...baseGraph,
    nodes: Array.from({ length: DOCX_PARSE_LIMITS.maxNodes + 1 }, (_, i) => ({ node_key: `n${i}` })),
  }),
  `${DOCX_PARSE_LIMITS.maxNodes}`,
);

expectThrow(
  'rejects too many chunks',
  () => assertDocxGraphBounds({
    ...baseGraph,
    chunks: Array.from({ length: DOCX_PARSE_LIMITS.maxChunks + 1 }, (_, i) => ({
      node_key: 'a', chunk_index: i, chunk_text: 'x',
    })),
  }),
  `${DOCX_PARSE_LIMITS.maxChunks}`,
);

expectThrow(
  'rejects zero nodes',
  () => assertDocxGraphBounds({ ...baseGraph, nodes: [] }),
  'zero sections',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
