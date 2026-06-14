/**
 * Smoke test for Google Document AI adapter (no DB writes).
 *
 * Usage:
 *   node scripts/test-google-doc-ai-adapter.mjs
 *   node scripts/test-google-doc-ai-adapter.mjs path/to/docai-response.json
 */
import { readFileSync } from 'fs';
import { GoogleDocAiAdapter, BLOCK_ROLE } from '../lib/ingest/adapters/index.js';

const RULEBOOK_ID = '00000000-0000-4000-8000-000000000001';

const SAMPLE_PAYLOAD = {
  document: {
    mimeType: 'application/pdf',
    text: 'RULE 505\nMust Attempt to Avoid Contact\nA runner must slide or attempt to avoid contact.\n\nRULE 506\nObstruction\nObstruction is the act of a fielder.',
    pages: [
      {
        pageNumber: 1,
        dimension: { width: 612, height: 792, unit: 'PT' },
        paragraphs: [
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '0', endIndex: '8' }] },
              confidence: 0.99,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.05 }, { x: 0.4, y: 0.05 },
                  { x: 0.4, y: 0.08 }, { x: 0.1, y: 0.08 },
                ],
              },
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '9', endIndex: '38' }] },
              confidence: 0.97,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.09 }, { x: 0.7, y: 0.09 },
                  { x: 0.7, y: 0.12 }, { x: 0.1, y: 0.12 },
                ],
              },
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '39', endIndex: '84' }] },
              confidence: 0.95,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.14 }, { x: 0.9, y: 0.14 },
                  { x: 0.9, y: 0.18 }, { x: 0.1, y: 0.18 },
                ],
              },
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '86', endIndex: '94' }] },
              confidence: 0.98,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.22 }, { x: 0.35, y: 0.22 },
                  { x: 0.35, y: 0.25 }, { x: 0.1, y: 0.25 },
                ],
              },
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '95', endIndex: '107' }] },
              confidence: 0.96,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.26 }, { x: 0.5, y: 0.26 },
                  { x: 0.5, y: 0.29 }, { x: 0.1, y: 0.29 },
                ],
              },
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: '108', endIndex: '149' }] },
              confidence: 0.94,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.1, y: 0.31 }, { x: 0.85, y: 0.31 },
                  { x: 0.85, y: 0.35 }, { x: 0.1, y: 0.35 },
                ],
              },
            },
          },
        ],
      },
    ],
  },
};

const payloadPath = process.argv[2];
const payload = payloadPath
  ? JSON.parse(readFileSync(payloadPath, 'utf8'))
  : SAMPLE_PAYLOAD;

const adapter = new GoogleDocAiAdapter({ rulebookId: RULEBOOK_ID });
const result  = adapter.transform(payload);

let ok = true;
function check(label, cond) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); ok = false; }
}

console.log('\nGoogle Document AI adapter smoke test\n');

check('rulebookId preserved', result.rulebookId === RULEBOOK_ID);
check('vendorAdapter is google-doc-ai', result.vendorAdapter === 'google-doc-ai');
check('one page produced', result.pages.length === 1);
check('blocks extracted', result.pages[0].blocks.length >= 4);
check('first block is rule heading', result.pages[0].blocks[0].role === BLOCK_ROLE.RULE_HEADING);
check('bbox normalized', result.pages[0].blocks[0].bbox?.coordinateSpace === 'normalized');
check('confidence in range', result.pages[0].blocks[0].confidence >= 0 && result.pages[0].blocks[0].confidence <= 1);
check('rawText non-empty', result.pages[0].rawText.trim().length > 0);

console.log(`\n  Pages: ${result.pages.length}, Blocks: ${result.pages[0].blocks.length}`);
console.log(`  Sample block: role=${result.pages[0].blocks[0].role}, confidence=${result.pages[0].blocks[0].confidence}`);

if (!ok) process.exit(1);
console.log('\nSmoke test passed.\n');
