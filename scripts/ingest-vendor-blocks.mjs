/**
 * scripts/ingest-vendor-blocks.mjs
 *
 * Merge BAMSBL Google Document AI fixtures, normalize via adapter,
 * and persist to extraction_runs / source_pages / source_blocks.
 *
 * Usage:
 *   node scripts/ingest-vendor-blocks.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { GoogleDocAiAdapter } from '../lib/ingest/adapters/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_VERSION = 'canonical-v1';
const FIXTURES = [
  { path: 'fixtures/bamsbl_1_14.json', pageOffset: 0, charOffset: 0 },
  { path: 'fixtures/bamsbl_15_28.json', pageOffset: 14, charOffset: null },
];

function loadLocalEnv() {
  try {
    for (const line of readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] ??= v;
    }
  } catch { /* ignore */ }
}

loadLocalEnv();

/**
 * @param {import('../lib/ingest/adapters/types.js').AdapterTransformResult} result
 * @param {{ pageOffset: number, charOffset: number }} opts
 */
function offsetResult(result, { pageOffset, charOffset }) {
  return {
    ...result,
    pages: result.pages.map(page => ({
      ...page,
      pageNumber: page.pageNumber + pageOffset,
      charOffsetStart: page.charOffsetStart != null ? page.charOffsetStart + charOffset : null,
      charOffsetEnd: page.charOffsetEnd != null ? page.charOffsetEnd + charOffset : null,
      blocks: page.blocks.map(block => ({
        ...block,
        charOffsetStart: block.charOffsetStart != null ? block.charOffsetStart + charOffset : null,
        charOffsetEnd: block.charOffsetEnd != null ? block.charOffsetEnd + charOffset : null,
      })),
    })),
  };
}

/**
 * @param {import('../lib/ingest/adapters/types.js').AdapterTransformResult[]} parts
 */
function mergeResults(parts) {
  const first = parts[0];
  return {
    rulebookId:     first.rulebookId,
    ruleDocumentId: first.ruleDocumentId,
    vendor:         first.vendor,
    vendorAdapter:  first.vendorAdapter,
    pages:          parts.flatMap(p => p.pages),
    warnings:       parts.flatMap(p => p.warnings ?? []),
    metadata:       {
      fixtureCount: parts.length,
      mergedAt: new Date().toISOString(),
    },
  };
}

async function resolveBamsbl(client) {
  const { rows } = await client.query(`
    SELECT
      l.slug,
      rv.id AS version_id,
      rd.id AS document_id,
      rd.source_hash
    FROM leagues l
    JOIN rulebook_versions rv ON rv.league_id = l.id
    JOIN rule_documents rd ON rd.version_id = rv.id
    WHERE l.slug = 'bamsbl'
      AND rv.status = 'active'
    ORDER BY rd.created_at DESC
    LIMIT 1
  `);
  if (rows.length === 0) {
    throw new Error('No active BAMSBL rulebook_version / rule_document found.');
  }
  return rows[0];
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const bamsbl = await resolveBamsbl(client);
  console.log(`Active BAMSBL version: ${bamsbl.version_id}`);
  console.log(`Rule document:         ${bamsbl.document_id}`);

  // Replace prior google-doc-ai extraction for this version (idempotent re-run).
  await client.query(`
    DELETE FROM extraction_runs
    WHERE rulebook_version_id = $1
      AND vendor = 'google-document-ai'
  `, [bamsbl.version_id]);

  const adapter = new GoogleDocAiAdapter({
    rulebookId: bamsbl.version_id,
    ruleDocumentId: bamsbl.document_id,
  });

  /** @type {import('../lib/ingest/adapters/types.js').AdapterTransformResult[]} */
  const parts = [];
  let globalCharOffset = 0;

  for (const fixture of FIXTURES) {
    const fullPath = resolve(__dirname, '..', fixture.path);
    const payload = JSON.parse(readFileSync(fullPath, 'utf8'));
    const charOffset = fixture.charOffset ?? globalCharOffset;
    console.log(`\nAdapting ${fixture.path} (pageOffset=${fixture.pageOffset}, charOffset=${charOffset}) …`);

    const raw = adapter.transform(payload);
    const offset = offsetResult(raw, { pageOffset: fixture.pageOffset, charOffset });
    parts.push(offset);

    const textLen = String(payload.text ?? '').length;
    globalCharOffset += textLen;
    console.log(`  → ${offset.pages.length} pages, ${offset.pages.reduce((n, p) => n + p.blocks.length, 0)} blocks`);
  }

  const merged = mergeResults(parts);
  console.log(`\nMerged: ${merged.pages.length} pages, ${merged.warnings.length} adapter warnings`);

  const runRes = await client.query(`
    INSERT INTO extraction_runs (
      rulebook_version_id, rule_document_id,
      vendor, vendor_adapter, vendor_version, pipeline_version,
      status, input_mime_type, input_source_hash,
      page_count, block_count, metadata,
      started_at, completed_at
    ) VALUES (
      $1, $2,
      $3, $4, $5, $6,
      'completed', 'application/pdf', $7,
      $8, $9, $10::jsonb,
      now(), now()
    )
    RETURNING id
  `, [
    bamsbl.version_id,
    bamsbl.document_id,
    merged.vendor,
    merged.vendorAdapter,
    'document-ocr',
    PIPELINE_VERSION,
    bamsbl.source_hash,
    merged.pages.length,
    merged.pages.reduce((n, p) => n + p.blocks.length, 0),
    JSON.stringify({ fixtures: FIXTURES.map(f => f.path), warnings: merged.warnings }),
  ]);

  const extractionRunId = runRes.rows[0].id;
  console.log(`\nExtraction run: ${extractionRunId}`);

  let totalBlocks = 0;
  for (const page of merged.pages) {
    const pageRes = await client.query(`
      INSERT INTO source_pages (
        extraction_run_id, rule_document_id, page_number,
        char_offset_start, char_offset_end,
        width_pt, height_pt, raw_text, layout_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING id
    `, [
      extractionRunId,
      bamsbl.document_id,
      page.pageNumber,
      page.charOffsetStart,
      page.charOffsetEnd,
      page.widthPt,
      page.heightPt,
      page.rawText,
      JSON.stringify(page.layoutMetadata ?? {}),
    ]);

    const sourcePageId = pageRes.rows[0].id;

    for (const block of page.blocks) {
      await client.query(`
        INSERT INTO source_blocks (
          extraction_run_id, source_page_id, block_index,
          block_type, char_offset_start, char_offset_end,
          bbox, exact_text, style_metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
      `, [
        extractionRunId,
        sourcePageId,
        block.blockIndex,
        block.blockType,
        block.charOffsetStart,
        block.charOffsetEnd,
        block.bbox ? JSON.stringify(block.bbox) : null,
        block.exactText,
        JSON.stringify({
          ...(block.styleMetadata ?? {}),
          role: block.role,
          confidence: block.confidence,
        }),
      ]);
      totalBlocks += 1;
    }
  }

  await client.query(`
    UPDATE extraction_runs
    SET block_count = $2, page_count = $3
    WHERE id = $1
  `, [extractionRunId, totalBlocks, merged.pages.length]);

  await client.query('COMMIT');

  console.log(`\n✓ Persisted ${merged.pages.length} pages, ${totalBlocks} blocks`);
  console.log(`  extraction_run_id = ${extractionRunId}`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Ingest failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
