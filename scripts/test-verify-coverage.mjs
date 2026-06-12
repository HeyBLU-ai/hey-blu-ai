/**
 * scripts/test-verify-coverage.mjs
 *
 * Unit tests for lib/ingest/verify-coverage.mjs.
 *
 * Fully deterministic — no AI calls, no network, no database.
 * Run with: node scripts/test-verify-coverage.mjs
 */

import { verifyCoverage } from '../lib/ingest/verify-coverage.mjs';

// ── Scaffolding ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function expectThrows(label, fn) {
  try {
    await fn();
    console.error(`  ✗ ${label} — expected an error but none was thrown`);
    failed++;
    return null;
  } catch (err) {
    console.log(`  ✓ ${label}`);
    passed++;
    return err;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Span text constants long enough to trigger LOW_DENSITY checks (> 200 chars).
const LONG_TEXT =
  'Rule 505. Must Slide Rule. A runner who does not slide and causes a collision with ' +
  'a fielder holding the ball shall be declared out by the umpire. ' +
  'This rule applies at every base, including home plate, regardless of whether the ' +
  'fielder is in the baseline. Failure to comply results in automatic out call.';   // 290 chars

const SHORT_TEXT_A = 'Rule 100. Age Minimum. Players must be 18 years of age.';  // 55 chars
const SHORT_TEXT_B = 'Rule 101. Registration. All players must register.';        // 50 chars

// IDs
const SID_1 = 'span0001-0000-0000-0000-000000000001';
const SID_2 = 'span0002-0000-0000-0000-000000000002';
const SID_3 = 'span0003-0000-0000-0000-000000000003';
const SID_4 = 'span0004-0000-0000-0000-000000000004';

// Spans across pages 1-4
const SPAN_P1 = { seq: 0, text: SHORT_TEXT_A, page: 1, charStart: 0, charEnd: SHORT_TEXT_A.length };
const SPAN_P2 = { seq: 1, text: SHORT_TEXT_B, page: 2, charStart: SHORT_TEXT_A.length + 1, charEnd: SHORT_TEXT_A.length + 1 + SHORT_TEXT_B.length };
const SPAN_P3 = { seq: 2, text: LONG_TEXT,    page: 3, charStart: 0, charEnd: LONG_TEXT.length };
const SPAN_P4 = { seq: 3, text: SHORT_TEXT_A, page: 4, charStart: 0, charEnd: SHORT_TEXT_A.length };

// Atoms that correctly claim the spans above
const ATOM_1 = { sourceSpanId: SID_1, source_ids: [SID_1], rule_number: '100', title: 'Age Min', body: SHORT_TEXT_A };
const ATOM_2 = { sourceSpanId: SID_2, source_ids: [SID_2], rule_number: '101', title: 'Registration', body: SHORT_TEXT_B };
const ATOM_3 = { sourceSpanId: SID_3, source_ids: [SID_3], rule_number: '505', title: 'Must Slide', body: LONG_TEXT };
const ATOM_4 = { sourceSpanId: SID_4, source_ids: [SID_4], rule_number: '100', title: 'Age Min', body: SHORT_TEXT_A };

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n━━━  verifyCoverage test  ━━━');

// ── Test 1: argument validation — missing spans ───────────────────────────────
console.log('\nTest 1: throws when opts.spans is missing');
{
  const err = await expectThrows('1: no spans throws', () =>
    verifyCoverage({ atoms: [], spanIds: [] }),
  );
  check('1: message mentions spans', err?.message?.includes('spans'));
}

// ── Test 2: argument validation — missing atoms ───────────────────────────────
console.log('\nTest 2: throws when opts.atoms is missing');
{
  const err = await expectThrows('2: no atoms throws', () =>
    verifyCoverage({ spans: [], spanIds: [] }),
  );
  check('2: message mentions atoms', err?.message?.includes('atoms'));
}

// ── Test 3: argument validation — mismatched spanIds ─────────────────────────
console.log('\nTest 3: throws when spanIds length mismatches spans');
{
  const err = await expectThrows('3: spanIds mismatch throws', () =>
    verifyCoverage({ spans: [SPAN_P1], atoms: [], spanIds: [SID_1, SID_2] }),
  );
  check('3: message mentions parallel array', err?.message?.includes('parallel array'));
}

// ── Test 4: perfect coverage — all pages, all spans claimed ──────────────────
console.log('\nTest 4: perfect coverage — all pages 1-4 covered, no issues');
{
  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2, SPAN_P3, SPAN_P4],
    spanIds: [SID_1,   SID_2,   SID_3,   SID_4],
    atoms:   [ATOM_1,  ATOM_2,  ATOM_3,  ATOM_4],
  });

  check('4a: ok = true',             report.ok === true,      `got ${report.ok}`);
  check('4b: isComplete = true',     report.isComplete === true);
  check('4c: missingPages = []',     report.missingPages.length === 0);
  check('4d: totalPages = 4',        report.totalPages === 4, `got ${report.totalPages}`);
  check('4e: coveredPages = 4',      report.coveredPages === 4);
  check('4f: coveredSpans = 4',      report.coveredSpans === 4);
  check('4g: spanCount = 4',         report.spanCount === 4);
  check('4h: atomCount = 4',         report.atomCount === 4);
  check('4i: issues = []',           report.issues.length === 0, `got ${report.issues.length}`);
}

// ── Test 5: span on p3 has no atom → p3 is a missing page ────────────────────
// All four pages have spans, but the span on p3 has no atom claiming it.
// missingPages = [3] because pagesWithSpans = {1,2,3,4} and pagesWithAtoms = {1,2,4}.
console.log('\nTest 5: gap in coverage — span on p3 has no atom → p3 is missing page');
{
  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2, SPAN_P3, SPAN_P4],
    spanIds: [SID_1,   SID_2,   SID_3,   SID_4],
    atoms:   [ATOM_1,  ATOM_2,           ATOM_4],  // no atom for SID_3 (p3)
  });

  check('5a: ok = false',               report.ok === false,   `got ${report.ok}`);
  check('5b: isComplete = false',       report.isComplete === false);
  check('5c: missingPages = [3]',       JSON.stringify(report.missingPages) === '[3]',
        `got ${JSON.stringify(report.missingPages)}`);
  check('5d: totalPages = 4',           report.totalPages === 4, `got ${report.totalPages}`);
  check('5e: coveredPages = 4',         report.coveredPages === 4, `got ${report.coveredPages}`);
  check('5f: no QUOTE_MISMATCH issues', !report.issues.some(i => i.code === 'QUOTE_MISMATCH'));
}

// ── Test 6: span on p3 has no atom; totalPages override still surfaces ────────
// Spans exist on p1, p2, p3.  Atoms cover p1 and p2 only.
// missingPages = [3] because p3 has a span but no atom.
// The totalPages=5 override is surfaced in report.totalPages (for reporting)
// but does NOT affect missingPages — blank pages 4 and 5 have no spans and
// are therefore not expected to have atoms.
console.log('\nTest 6: span on p3 uncovered — missingPages = [3]; totalPages override surfaced');
{
  const report = await verifyCoverage({
    spans:      [SPAN_P1, SPAN_P2, SPAN_P3],
    spanIds:    [SID_1,   SID_2,   SID_3],
    atoms:      [ATOM_1,  ATOM_2],              // no atom for SID_3 (p3)
    totalPages: 5,
  });

  check('6a: isComplete = false',        report.isComplete === false);
  check('6b: missingPages = [3]',        JSON.stringify(report.missingPages) === '[3]',
        `got ${JSON.stringify(report.missingPages)}`);
  check('6c: totalPages = 5 (override)', report.totalPages === 5, `got ${report.totalPages}`);
  check('6d: coveredPages = 3',          report.coveredPages === 3, `got ${report.coveredPages}`);
}

// ── Test 7: multiple non-consecutive uncovered pages ─────────────────────────
// Spans exist on p1–p5.  Atoms cover only p1, p3, p5.
// p2 and p4 have spans but no atoms → missingPages = [2, 4].
// (A hypothetical page 6 is irrelevant because it has no span.)
console.log('\nTest 7: spans on p1-p5, atoms on p1/p3/p5 → missingPages = [2, 4]');
{
  const SPAN_P2b = { seq: 1, text: SHORT_TEXT_B, page: 2, charStart: 0, charEnd: SHORT_TEXT_B.length };
  const SPAN_P4b = { seq: 3, text: SHORT_TEXT_B, page: 4, charStart: 0, charEnd: SHORT_TEXT_B.length };
  const SPAN_P5  = { seq: 4, text: SHORT_TEXT_A, page: 5, charStart: 0, charEnd: SHORT_TEXT_A.length };
  const ATOM_5   = { sourceSpanId: 'sid5', source_ids: ['sid5'], rule_number: '105', title: 'T', body: SHORT_TEXT_A };

  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2b, SPAN_P3, SPAN_P4b, SPAN_P5],
    spanIds: [SID_1,   'sid2b',  SID_3,   'sid4b',  'sid5'],
    atoms:   [ATOM_1,            ATOM_3,             ATOM_5],  // p2, p4 uncovered
  });

  check('7a: missingPages = [2,4]',
        JSON.stringify(report.missingPages) === '[2,4]',
        `got ${JSON.stringify(report.missingPages)}`);
  check('7b: isComplete = false',   report.isComplete === false);
  check('7c: coveredPages = 5',     report.coveredPages === 5, `got ${report.coveredPages}`);
}

// ── Test 8: UNCOVERED_SPAN — span has no atoms ────────────────────────────────
console.log('\nTest 8: UNCOVERED_SPAN — span with no associated atoms');
{
  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2],
    spanIds: [SID_1,   SID_2],
    atoms:   [ATOM_1],              // SPAN_P2 / SID_2 unclaimed
  });

  const uncov = report.issues.filter(i => i.code === 'UNCOVERED_SPAN');
  check('8a: 1 UNCOVERED_SPAN issue',   uncov.length === 1, `got ${uncov.length}`);
  check('8b: flagged spanSeq = 1',      uncov[0]?.spanSeq === 1, `got ${uncov[0]?.spanSeq}`);
  check('8c: coveredSpans = 1',         report.coveredSpans === 1);
  // Under the new page-coverage logic, SPAN_P2 (page 2) has a span but no atom
  // → page 2 is in missingPages → isComplete = false → ok = false.
  check('8d: ok = false because p2 span has no atom (missing page)',
        report.ok === false, `got ${report.ok}`);
}

// ── Test 9: QUOTE_MISMATCH — atom body not verbatim in span ──────────────────
console.log('\nTest 9: QUOTE_MISMATCH — atom body has been paraphrased');
{
  const paraphrasedAtom = {
    sourceSpanId: SID_1,
    source_ids:   [SID_1],
    rule_number:  '100',
    title:        'Age Min',
    body:         'Players must be at least 18 years old.',   // not in SHORT_TEXT_A
  };

  const report = await verifyCoverage({
    spans:   [SPAN_P1],
    spanIds: [SID_1],
    atoms:   [paraphrasedAtom],
  });

  const mismatches = report.issues.filter(i => i.code === 'QUOTE_MISMATCH');
  check('9a: 1 QUOTE_MISMATCH issue',    mismatches.length === 1, `got ${mismatches.length}`);
  check('9b: ok = false (mismatch)',     report.ok === false);
  check('9c: spanSeq recorded',          mismatches[0]?.spanSeq === 0);
  check('9d: message contains body preview', mismatches[0]?.message?.includes('Players must be'));
}

// ── Test 10: LOW_DENSITY — long span with one very short atom ─────────────────
console.log('\nTest 10: LOW_DENSITY — span is 290 chars, atom body is 15 chars');
{
  const shortBodyAtom = {
    sourceSpanId: SID_3,
    source_ids:   [SID_3],
    rule_number:  '505',
    title:        'Must Slide',
    body:         'Rule 505. Must',   // only 14 chars, well under MIN_ATOM_BODY_CHARS
  };

  const report = await verifyCoverage({
    spans:      [SPAN_P3],    // LONG_TEXT = 290 chars
    spanIds:    [SID_3],
    atoms:      [shortBodyAtom],
    totalPages: 0,            // disable page-gap check — isolating LOW_DENSITY only
  });

  const low = report.issues.filter(i => i.code === 'LOW_DENSITY');
  check('10a: 1 LOW_DENSITY issue',    low.length === 1, `got ${low.length}`);
  check('10b: spanSeq = 2',            low[0]?.spanSeq === 2, `got ${low[0]?.spanSeq}`);
  check('10c: ok unaffected by LOW_DENSITY', report.ok === true,
        'LOW_DENSITY alone should not set ok=false');
}

// ── Test 11: spans with page=null (e.g. DOCX) skipped from page check ─────────
console.log('\nTest 11: all page=null spans (DOCX) → isComplete=true, totalPages=0');
{
  const DOCX_SPAN_1 = { seq: 0, text: SHORT_TEXT_A, page: null, charStart: 0, charEnd: SHORT_TEXT_A.length };
  const DOCX_SPAN_2 = { seq: 1, text: SHORT_TEXT_B, page: null, charStart: 0, charEnd: SHORT_TEXT_B.length };
  const DOCX_ATOM_1 = { sourceSpanId: 'ds1', source_ids: ['ds1'], rule_number: '', title: 'T1', body: SHORT_TEXT_A };
  const DOCX_ATOM_2 = { sourceSpanId: 'ds2', source_ids: ['ds2'], rule_number: '', title: 'T2', body: SHORT_TEXT_B };

  const report = await verifyCoverage({
    spans:   [DOCX_SPAN_1, DOCX_SPAN_2],
    spanIds: ['ds1',        'ds2'],
    atoms:   [DOCX_ATOM_1,  DOCX_ATOM_2],
  });

  check('11a: isComplete = true',     report.isComplete === true);
  check('11b: totalPages = 0',        report.totalPages === 0, `got ${report.totalPages}`);
  check('11c: missingPages = []',     report.missingPages.length === 0);
  check('11d: coveredPages = 0',      report.coveredPages === 0);
  check('11e: ok = true',             report.ok === true);
}

// ── Test 12: no atoms at all → all spans uncovered ───────────────────────────
console.log('\nTest 12: zero atoms → all spans flagged as UNCOVERED_SPAN');
{
  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2],
    spanIds: [SID_1,   SID_2],
    atoms:   [],
  });

  const uncov = report.issues.filter(i => i.code === 'UNCOVERED_SPAN');
  check('12a: 2 UNCOVERED_SPAN issues',  uncov.length === 2, `got ${uncov.length}`);
  check('12b: coveredSpans = 0',         report.coveredSpans === 0);
  // Zero atoms → pagesWithAtoms = {} → pages 1 & 2 in missingPages → ok = false.
  check('12c: ok = false — zero atoms means all span pages are missing',
        report.ok === false, `got ${report.ok}`);
}

// ── Test 13: empty spans + empty atoms → trivial success ─────────────────────
console.log('\nTest 13: empty spans + empty atoms → no issues, isComplete=true');
{
  const report = await verifyCoverage({ spans: [], atoms: [], spanIds: [] });
  check('13a: ok = true',            report.ok === true);
  check('13b: isComplete = true',    report.isComplete === true);
  check('13c: totalPages = 0',       report.totalPages === 0);
  check('13d: issues = []',          report.issues.length === 0);
  check('13e: spanCount = 0',        report.spanCount === 0);
  check('13f: atomCount = 0',        report.atomCount === 0);
}

// ── Test 14: cross-span atom — body found in concatenation ────────────────────
// The atom cites two spans; body equals SHORT_TEXT_A which is the text of
// SPAN_P1 alone.  The new logic joins all cited spans' texts and searches the
// concatenation.  SHORT_TEXT_A IS found in the join (it's the first part),
// so no QUOTE_MISMATCH is expected.
console.log('\nTest 14: cross-span atom — body in first span → no QUOTE_MISMATCH');
{
  const crossAtom = {
    sourceSpanId: SID_1,
    source_ids:   [SID_1, SID_2],
    rule_number:  '100',
    title:        'Age Min',
    body:         SHORT_TEXT_A,    // found in the concatenation of SPAN_P1+SPAN_P2
  };

  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2],
    spanIds: [SID_1,   SID_2],
    atoms:   [crossAtom],
  });

  // Both spans are claimed by the atom.
  check('14a: coveredSpans = 2',           report.coveredSpans === 2, `got ${report.coveredSpans}`);
  // Body found in concatenation → no QUOTE_MISMATCH
  const mm = report.issues.filter(i => i.code === 'QUOTE_MISMATCH');
  check('14b: no QUOTE_MISMATCH for cross-span', mm.length === 0, `got ${mm.length}`);
  check('14c: ok = true',                  report.ok === true, `got ${report.ok}`);
}

// ── Test 15: opts.totalPages = 0 → no page checks run ────────────────────────
console.log('\nTest 15: opts.totalPages = 0 → page check skipped, isComplete=true');
{
  const report = await verifyCoverage({
    spans:      [SPAN_P1, SPAN_P2],
    spanIds:    [SID_1,   SID_2],
    atoms:      [ATOM_1,  ATOM_2],
    totalPages: 0,
  });

  check('15a: totalPages = 0',        report.totalPages === 0);
  check('15b: isComplete = true',     report.isComplete === true);
  check('15c: missingPages = []',     report.missingPages.length === 0);
}

// ── Test 16: combined — QUOTE_MISMATCH + uncovered page → ok=false ────────────
// Spans on p1, p2, p3.  p1 has a bad-body atom (QUOTE_MISMATCH).
// p2 has a span but no atom (uncovered → missingPages = [2], isComplete = false).
// p3 has a valid atom.
// Both failures must be reflected in ok=false.
console.log('\nTest 16: QUOTE_MISMATCH AND uncovered span page both set ok=false');
{
  const badAtom = {
    sourceSpanId: SID_1,
    source_ids:   [SID_1],
    rule_number:  '100',
    title:        'Age Min',
    body:         'completely fabricated body text that does not exist in the span',
  };

  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2, SPAN_P3],  // p1=bad atom, p2=no atom, p3=good atom
    spanIds: [SID_1,   SID_2,   SID_3],
    atoms:   [badAtom,           ATOM_3],   // no atom for SID_2 (p2)
  });

  check('16a: ok = false',                report.ok === false);
  check('16b: isComplete = false',        report.isComplete === false);
  check('16c: QUOTE_MISMATCH present',    report.issues.some(i => i.code === 'QUOTE_MISMATCH'));
  check('16d: missingPages includes 2',   report.missingPages.includes(2),
        `got ${JSON.stringify(report.missingPages)}`);
}

// ── Test 17: UNCOVERED_SPAN message is clearly reportable ────────────────────
// Verifies that the issue object contains enough information for an operator to
// identify and act on every uncovered span without querying the database:
//   - code = 'UNCOVERED_SPAN'
//   - message mentions the span seq number
//   - message mentions the span ID prefix
//   - message warns that rule text may have been dropped
console.log('\nTest 17: UNCOVERED_SPAN issue message clearly identifies the dropped span');
{
  const report = await verifyCoverage({
    spans:   [SPAN_P1, SPAN_P2, SPAN_P3],
    spanIds: [SID_1,   SID_2,   SID_3],
    atoms:   [ATOM_1,           ATOM_3],   // SPAN_P2 / SID_2 has no atom
  });

  const uncov = report.issues.filter(i => i.code === 'UNCOVERED_SPAN');
  check('17a: exactly 1 UNCOVERED_SPAN issue',       uncov.length === 1, `got ${uncov.length}`);
  check('17b: issue.code = "UNCOVERED_SPAN"',        uncov[0]?.code === 'UNCOVERED_SPAN');
  check('17c: issue.spanSeq = 1 (seq of SPAN_P2)',   uncov[0]?.spanSeq === 1,
        `got ${uncov[0]?.spanSeq}`);

  // Message must be self-contained enough to act on without a DB lookup
  const msg = uncov[0]?.message ?? '';
  check('17d: message includes the span seq number', msg.includes('1'),
        `message: "${msg}"`);
  check('17e: message includes span ID prefix',      msg.includes(SID_2.slice(0, 8)),
        `message: "${msg}"`);
  check('17f: message warns about dropped rule text', msg.includes('silently dropped') || msg.includes('no associated atoms'),
        `message: "${msg}"`);

  // Page-level consequence: SPAN_P2 is on page 2, no atom → page 2 is missing
  check('17g: ok = false because uncovered span causes missing page',
        report.ok === false, `got ${report.ok}`);
  check('17h: missingPages includes 2',              report.missingPages.includes(2),
        `got ${JSON.stringify(report.missingPages)}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
