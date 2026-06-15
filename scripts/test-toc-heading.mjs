#!/usr/bin/env node
/**
 * Unit checks for isTocHeading — real rule headings on early pages must not be skipped.
 */
import { isTocHeading } from '../lib/ingest/canonicalizer.js';

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log('isTocHeading tests\n');

check('305 Uniforms on page 1 is NOT toc', !isTocHeading('305. Uniforms (revised 2023)', 1));
check('300 chapter line on page 1 is NOT toc', !isTocHeading('300. EQUIPMENT AND UNIFORMS', 1));
check('310 Cleats on page 2 is NOT toc', !isTocHeading('310. Cleats/Spikes', 2));
check('dot-leader TOC on page 1 IS toc', isTocHeading('305. Uniforms ................ 4', 1));
check('spaced page ref TOC on page 2 IS toc', isTocHeading('420. Batting Line-up     5', 2));
check('page 5 never toc even with leaders', !isTocHeading('305. Uniforms .... 4', 5));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
