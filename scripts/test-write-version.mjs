/**
 * scripts/test-write-version.mjs
 *
 * Unit tests for createDraftVersion() in lib/ingest/write-rulebook-version.mjs.
 *
 * All DB calls are intercepted by a mock client — no real Postgres needed.
 * Run with: node scripts/test-write-version.mjs
 */

import { createDraftVersion } from '../lib/ingest/write-rulebook-version.mjs';

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

const LEAGUE_ID   = 'league00-0000-0000-0000-000000000001';
const SOURCE_HASH = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc12'; // 64 hex chars

const DOC_META = {
  source_file:   '2026bamsblrules.pdf',
  mime_type:     'application/pdf',
  parse_method:  'pdf-parse',
};

const DOC_META_NO_MIME = {
  source_file:  'rulebook.docx',
  parse_method: 'mammoth',
  // mime_type intentionally absent
};

// ── Mock DB factory ───────────────────────────────────────────────────────────

/**
 * Build a mock pg-compatible client.
 * Returns synthetic UUIDs: version inserts → 'version-uuid-1',
 * document inserts → 'doc-uuid-2', etc.
 */
function makeMockDb() {
  const calls = [];
  let counter = 0;
  return {
    calls,
    async query(text, values) {
      counter++;
      const norm = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: norm, values });
      return { rows: [{ id: `mock-uuid-${counter}` }] };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n━━━  createDraftVersion test  ━━━');

// ── Test 1: missing dbClient ──────────────────────────────────────────────────
console.log('\nTest 1: throws when opts.dbClient is missing');
{
  const err = await expectThrows('1: no dbClient throws', () =>
    createDraftVersion({ leagueId: LEAGUE_ID, sourceHash: SOURCE_HASH, documentMeta: DOC_META }),
  );
  check('1: message mentions dbClient', err?.message?.includes('dbClient'));
}

// ── Test 2: missing leagueId ──────────────────────────────────────────────────
console.log('\nTest 2: throws when opts.leagueId is missing');
{
  const db  = makeMockDb();
  const err = await expectThrows('2: no leagueId throws', () =>
    createDraftVersion({ dbClient: db, sourceHash: SOURCE_HASH, documentMeta: DOC_META }),
  );
  check('2: message mentions leagueId', err?.message?.includes('leagueId'));
}

// ── Test 3: missing sourceHash ────────────────────────────────────────────────
console.log('\nTest 3: throws when opts.sourceHash is missing');
{
  const db  = makeMockDb();
  const err = await expectThrows('3: no sourceHash throws', () =>
    createDraftVersion({ dbClient: db, leagueId: LEAGUE_ID, documentMeta: DOC_META }),
  );
  check('3: message mentions sourceHash', err?.message?.includes('sourceHash'));
}

// ── Test 4: missing documentMeta.source_file ──────────────────────────────────
console.log('\nTest 4: throws when opts.documentMeta.source_file is missing');
{
  const db  = makeMockDb();
  const err = await expectThrows('4: no source_file throws', () =>
    createDraftVersion({
      dbClient:     db,
      leagueId:     LEAGUE_ID,
      sourceHash:   SOURCE_HASH,
      documentMeta: { parse_method: 'pdf-parse' }, // source_file absent
    }),
  );
  check('4: message mentions source_file', err?.message?.includes('source_file'));
}

// ── Test 5: missing documentMeta.parse_method ─────────────────────────────────
console.log('\nTest 5: throws when opts.documentMeta.parse_method is missing');
{
  const db  = makeMockDb();
  const err = await expectThrows('5: no parse_method throws', () =>
    createDraftVersion({
      dbClient:     db,
      leagueId:     LEAGUE_ID,
      sourceHash:   SOURCE_HASH,
      documentMeta: { source_file: 'rules.pdf' }, // parse_method absent
    }),
  );
  check('5: message mentions parse_method', err?.message?.includes('parse_method'));
}

// ── Test 6: happy path — rulebook_versions INSERT SQL and parameters ──────────
console.log('\nTest 6: happy path — rulebook_versions INSERT SQL and parameters');
{
  const db = makeMockDb();
  await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    season:       '2026',
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
  });

  const versionCall = db.calls.find(c => c.text.includes('INSERT INTO rulebook_versions'));
  check('6a: rulebook_versions INSERT called',      versionCall != null);
  check('6b: SQL has status = \'draft\'',           versionCall?.text.includes("'draft'"));
  check('6c: SQL RETURNING id',                     versionCall?.text.includes('RETURNING id'));
  check('6d: $1 = leagueId',                        versionCall?.values[0] === LEAGUE_ID,
        `got "${versionCall?.values[0]}"`);
  check('6e: $2 = season "2026"',                   versionCall?.values[1] === '2026',
        `got "${versionCall?.values[1]}"`);
  check('6f: $3 = sourceHash',                      versionCall?.values[2] === SOURCE_HASH,
        `got "${versionCall?.values[2]}"`);
}

// ── Test 7: happy path — rule_documents INSERT SQL and parameters ─────────────
console.log('\nTest 7: happy path — rule_documents INSERT SQL and parameters');
{
  const db = makeMockDb();
  await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    season:       '2026',
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
  });

  const docCall = db.calls.find(c => c.text.includes('INSERT INTO rule_documents'));
  check('7a: rule_documents INSERT called',         docCall != null);
  check('7b: SQL RETURNING id',                     docCall?.text.includes('RETURNING id'));
  check('7c: $1 = leagueId',                        docCall?.values[0] === LEAGUE_ID);
  check('7d: $2 = versionId from step 1',           docCall?.values[1] === 'mock-uuid-1',
        `got "${docCall?.values[1]}"`);
  check('7e: $3 = season "2026"',                   docCall?.values[2] === '2026');
  check('7f: $4 = source_file',                     docCall?.values[3] === DOC_META.source_file);
  check('7g: $5 = sourceHash',                      docCall?.values[4] === SOURCE_HASH);
  check('7h: $6 = mime_type',                       docCall?.values[5] === DOC_META.mime_type);
  check('7i: $7 = parse_method',                    docCall?.values[6] === DOC_META.parse_method);
}

// ── Test 8: return value — versionId and documentId ──────────────────────────
console.log('\nTest 8: return value contains versionId and documentId');
{
  const db     = makeMockDb();
  const result = await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
  });

  check('8a: result.versionId = "mock-uuid-1"',  result.versionId  === 'mock-uuid-1',
        `got "${result.versionId}"`);
  check('8b: result.documentId = "mock-uuid-2"', result.documentId === 'mock-uuid-2',
        `got "${result.documentId}"`);
  check('8c: exactly 2 DB calls made',           db.calls.length === 2,
        `got ${db.calls.length}`);
}

// ── Test 9: versionId is threaded as version_id in the document INSERT ────────
console.log('\nTest 9: versionId from step 1 is used as $2 in the document INSERT');
{
  // Use a custom DB that returns distinct UUIDs to confirm threading
  let callN = 0;
  const db = {
    calls: [],
    async query(text, values) {
      callN++;
      const norm = text.replace(/\s+/g, ' ').trim();
      db.calls.push({ text: norm, values });
      const id = callN === 1 ? 'the-version-uuid' : 'the-document-uuid';
      return { rows: [{ id }] };
    },
  };

  const result = await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
  });

  check('9a: versionId = "the-version-uuid"',       result.versionId  === 'the-version-uuid');
  check('9b: documentId = "the-document-uuid"',      result.documentId === 'the-document-uuid');
  check('9c: doc INSERT $2 = versionId',             db.calls[1].values[1] === 'the-version-uuid',
        `got "${db.calls[1].values[1]}"`);
}

// ── Test 10: null season → NULL is passed to both INSERTs ─────────────────────
console.log('\nTest 10: omitted season → NULL passed for both rows');
{
  const db = makeMockDb();
  await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
    // season intentionally omitted
  });

  const vCall = db.calls.find(c => c.text.includes('INSERT INTO rulebook_versions'));
  const dCall = db.calls.find(c => c.text.includes('INSERT INTO rule_documents'));
  check('10a: version INSERT $2 (season) = null', vCall?.values[1] === null,
        `got "${vCall?.values[1]}"`);
  check('10b: document INSERT $3 (season) = null', dCall?.values[2] === null,
        `got "${dCall?.values[2]}"`);
}

// ── Test 11: null mime_type → NULL passed for rule_documents ──────────────────
console.log('\nTest 11: absent mime_type → NULL in rule_documents $6');
{
  const db = makeMockDb();
  await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META_NO_MIME,
  });

  const dCall = db.calls.find(c => c.text.includes('INSERT INTO rule_documents'));
  check('11: document INSERT $6 (mime_type) = null', dCall?.values[5] === null,
        `got "${dCall?.values[5]}"`);
}

// ── Test 12: call order — versions INSERT always before documents INSERT ───────
console.log('\nTest 12: call order — rulebook_versions always inserted before rule_documents');
{
  const db = makeMockDb();
  await createDraftVersion({
    dbClient:     db,
    leagueId:     LEAGUE_ID,
    sourceHash:   SOURCE_HASH,
    documentMeta: DOC_META,
  });

  const vIdx = db.calls.findIndex(c => c.text.includes('INSERT INTO rulebook_versions'));
  const dIdx = db.calls.findIndex(c => c.text.includes('INSERT INTO rule_documents'));
  check('12: versions INSERT (idx 0) precedes documents INSERT (idx 1)',
        vIdx === 0 && dIdx === 1,
        `versions at index ${vIdx}, documents at index ${dIdx}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
