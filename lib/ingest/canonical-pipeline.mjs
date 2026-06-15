/**
 * lib/ingest/canonical-pipeline.mjs
 *
 * End-to-end canonical graph ingestion:
 *   PDF → source_blocks → rule_nodes → embeddings → version activation
 */

import crypto from 'node:crypto';
import { transformPdfToBlocks } from './adapters/pdf-parse-blocks.js';
import { createDraftVersion } from './write-rulebook-version.mjs';
import { Canonicalizer } from './canonicalizer.js';
import {
  assertNoZeroChunkNodes,
  auditZeroChunkIntegrity,
} from './integrity-gates.mjs';

export const PIPELINE_VERSION = 'canonical-v1';

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} leagueSlug
 */
export async function resolveLeagueBySlug(dbClient, leagueSlug) {
  const { rows } = await dbClient.query(
    `SELECT id, slug, name FROM leagues WHERE slug = $1`,
    [leagueSlug],
  );
  if (!rows.length) throw new Error(`League "${leagueSlug}" not found.`);
  return rows[0];
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} leagueId
 * @param {string} sourceHash
 */
export async function findDocumentByHash(dbClient, leagueId, sourceHash) {
  const { rows } = await dbClient.query(`
    SELECT rd.id AS document_id, rv.id AS version_id, rv.status
    FROM rule_documents rd
    JOIN rulebook_versions rv ON rv.id = rd.version_id
    WHERE rd.league_id = $1 AND rd.source_hash = $2
    ORDER BY rv.created_at DESC
    LIMIT 1
  `, [leagueId, sourceHash]);
  return rows[0] ?? null;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} versionId
 */
export async function deleteDraftVersionCascade(dbClient, versionId) {
  await dbClient.query(`DELETE FROM rulebook_versions WHERE id = $1 AND status = 'draft'`, [versionId]);
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {import('./adapters/types.js').AdapterTransformResult} merged
 * @param {string} versionId
 * @param {string} documentId
 * @param {string} sourceHash
 */
export async function persistExtractionRun(dbClient, merged, versionId, documentId, sourceHash) {
  await dbClient.query(`
    DELETE FROM extraction_runs
    WHERE rulebook_version_id = $1
      AND vendor = $2
  `, [versionId, merged.vendor]);

  const blockCount = merged.pages.reduce((n, p) => n + p.blocks.length, 0);

  const runRes = await dbClient.query(`
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
    versionId,
    documentId,
    merged.vendor,
    merged.vendorAdapter,
    'pdf-parse',
    PIPELINE_VERSION,
    sourceHash,
    merged.pages.length,
    blockCount,
    JSON.stringify(merged.metadata ?? {}),
  ]);

  const extractionRunId = runRes.rows[0].id;
  let totalBlocks = 0;

  for (const page of merged.pages) {
    const pageRes = await dbClient.query(`
      INSERT INTO source_pages (
        extraction_run_id, rule_document_id, page_number,
        char_offset_start, char_offset_end,
        width_pt, height_pt, raw_text, layout_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING id
    `, [
      extractionRunId,
      documentId,
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
      await dbClient.query(`
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

  await dbClient.query(`
    UPDATE extraction_runs
    SET block_count = $2, page_count = $3
    WHERE id = $1
  `, [extractionRunId, totalBlocks, merged.pages.length]);

  return { extractionRunId, pageCount: merged.pages.length, blockCount: totalBlocks };
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} extractionRunId
 * @param {string} versionId
 */
export async function persistCanonicalGraph(dbClient, extractionRunId, versionId) {
  const { rows: [run] } = await dbClient.query(
    `SELECT id, rulebook_version_id FROM extraction_runs WHERE id = $1`,
    [extractionRunId],
  );
  if (!run) throw new Error(`extraction_run ${extractionRunId} not found`);

  await dbClient.query(`DELETE FROM canonicalization_warnings WHERE extraction_run_id = $1`, [extractionRunId]);
  await dbClient.query(`DELETE FROM rule_nodes WHERE extraction_run_id = $1`, [extractionRunId]);

  const canonicalizer = new Canonicalizer(dbClient, extractionRunId);
  const { nodes, chunks, warnings } = await canonicalizer.run();

  const keyToId = new Map();

  for (const node of nodes) {
    const parentId = node.parent_key ? keyToId.get(node.parent_key) ?? null : null;
    const materializedPath = node.parent_key
      ? `${node.parent_key}/${node.node_key}`
      : node.node_key;

    const res = await dbClient.query(`
      INSERT INTO rule_nodes (
        extraction_run_id, rulebook_version_id, parent_id,
        node_type, node_key, rule_number, title, body_text,
        sort_order, depth, materialized_path,
        page_start, page_end, char_start, char_end,
        source_block_ids, metadata
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16::uuid[], $17::jsonb
      )
      RETURNING id
    `, [
      extractionRunId,
      versionId,
      parentId,
      node.node_type,
      node.node_key,
      node.rule_number,
      node.title,
      node.body_text,
      node.sort_order,
      node.depth,
      materializedPath,
      node.page_start,
      node.page_end,
      node.char_start,
      node.char_end,
      node.source_block_ids,
      JSON.stringify(node.metadata ?? {}),
    ]);

    keyToId.set(node.node_key, res.rows[0].id);
  }

  for (const chunk of chunks) {
    const nodeId = keyToId.get(chunk.node_key);
    if (!nodeId) continue;

    await dbClient.query(`
      INSERT INTO rule_node_chunks (
        rule_node_id, extraction_run_id, chunk_index,
        chunk_text, char_start, char_end, source_block_ids
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[])
    `, [
      nodeId,
      extractionRunId,
      chunk.chunk_index,
      chunk.chunk_text,
      chunk.char_start,
      chunk.char_end,
      chunk.source_block_ids,
    ]);
  }

  let blockingWarnings = 0;
  let warningCount = 0;
  for (const w of warnings) {
    const ruleNodeId = w.node_key ? keyToId.get(w.node_key) ?? null : null;
    if (w.is_blocking) blockingWarnings += 1;
    warningCount += 1;
    await dbClient.query(`
      INSERT INTO canonicalization_warnings (
        extraction_run_id, rulebook_version_id, rule_node_id,
        source_block_id, source_page_id,
        warning_code, severity, message, details, is_blocking
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    `, [
      extractionRunId,
      versionId,
      ruleNodeId,
      w.source_block_id ?? null,
      w.source_page_id ?? null,
      w.warning_code,
      w.severity ?? 'warning',
      w.message,
      JSON.stringify(w.details ?? {}),
      w.is_blocking ?? false,
    ]);
  }

  const integrity = await auditZeroChunkIntegrity(dbClient, versionId, extractionRunId);
  blockingWarnings += integrity.warningsInserted;
  warningCount += integrity.warningsInserted;

  await dbClient.query(`
    UPDATE extraction_runs
    SET node_count = $2, warning_count = $3, blocking_warning_count = $4
    WHERE id = $1
  `, [extractionRunId, nodes.length, warningCount, blockingWarnings]);

  return {
    nodeCount: nodes.length,
    chunkCount: chunks.length,
    warningCount,
    blockingWarningCount: blockingWarnings,
    zeroChunkNodeCount: integrity.zeroChunkNodes.length,
  };
}

function vectorLiteral(values) {
  return `[${values.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

function embeddingInput(row) {
  return [
    row.rule_number ? `Rule ${row.rule_number}` : null,
    row.title ? `Title: ${row.title}` : null,
    row.chunk_text,
  ].filter(Boolean).join('\n');
}

const EMBED_BATCH_SIZE = 64;

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} versionId
 * @param {import('openai').default} openai
 * @param {(embedded: number, total: number) => void} [onBatch]
 */
export async function embedChunksForVersion(dbClient, versionId, openai, onBatch) {
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

  const { rows: chunks } = await dbClient.query(`
    SELECT c.id, c.chunk_text, n.rule_number, n.title
    FROM rule_node_chunks c
    JOIN rule_nodes n ON n.id = c.rule_node_id
    WHERE n.rulebook_version_id = $1
      AND c.embedding IS NULL
    ORDER BY n.rule_number NULLS LAST, c.chunk_index
  `, [versionId]);

  const total = chunks.length;
  let embedded = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const result = await openai.embeddings.create({
      model,
      input: batch.map(embeddingInput),
      dimensions: 1536,
    });

    if (!result.data || result.data.length !== batch.length) {
      throw new Error(`Embedding batch returned ${result.data?.length ?? 0}/${batch.length} vectors`);
    }

    const byIndex = new Map(result.data.map(row => [row.index, row.embedding]));

    for (let j = 0; j < batch.length; j += 1) {
      const chunk = batch[j];
      const embedding = byIndex.get(j);
      if (!embedding || embedding.length !== 1536) {
        throw new Error(`Invalid embedding for chunk ${chunk.id}`);
      }
      await dbClient.query(
        `UPDATE rule_node_chunks SET embedding = $1::vector WHERE id = $2`,
        [vectorLiteral(embedding), chunk.id],
      );
      embedded += 1;
    }

    onBatch?.(embedded, total);
  }

  return { embedded, pending: total };
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} versionId
 */
export async function activateCanonicalVersion(dbClient, versionId) {
  const { rows: [version] } = await dbClient.query(`
    SELECT rv.id, rv.status, rv.league_id, l.slug AS league_slug, l.name AS league_name
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE rv.id = $1
  `, [versionId]);

  if (!version) throw new Error(`Version ${versionId} not found.`);
  if (version.status === 'active') {
    return { alreadyActive: true, versionId, leagueSlug: version.league_slug };
  }

  const { rows: [counts] } = await dbClient.query(`
    SELECT
      (SELECT COUNT(*)::int FROM rule_nodes WHERE rulebook_version_id = $1) AS nodes,
      (SELECT COUNT(*)::int FROM rule_node_chunks c
         JOIN rule_nodes n ON n.id = c.rule_node_id
        WHERE n.rulebook_version_id = $1) AS chunks,
      (SELECT COUNT(*)::int FROM rule_node_chunks c
         JOIN rule_nodes n ON n.id = c.rule_node_id
        WHERE n.rulebook_version_id = $1 AND c.embedding IS NULL) AS unembedded,
      (SELECT COUNT(*)::int FROM canonicalization_warnings
        WHERE rulebook_version_id = $1 AND is_blocking = true) AS blocking_warnings
  `, [versionId]);

  if (counts.nodes === 0) {
    throw new Error('Cannot activate: no rule_nodes were created for this version.');
  }
  if (counts.chunks === 0) {
    throw new Error('Cannot activate: no rule_node_chunks were created for this version.');
  }
  if (counts.unembedded > 0) {
    throw new Error(`Cannot activate: ${counts.unembedded} chunk(s) still missing embeddings.`);
  }
  if (counts.blocking_warnings > 0) {
    throw new Error(`Cannot activate: ${counts.blocking_warnings} blocking canonicalization warning(s) remain.`);
  }

  await assertNoZeroChunkNodes(dbClient, versionId);

  await dbClient.query(`
    UPDATE rulebook_versions
    SET status = 'retired', updated_at = now()
    WHERE league_id = $1 AND status = 'active' AND id <> $2
  `, [version.league_id, versionId]);

  await dbClient.query(`
    UPDATE rulebook_versions
    SET status = 'active', updated_at = now()
    WHERE id = $1
  `, [versionId]);

  return {
    versionId,
    leagueSlug: version.league_slug,
    leagueName: version.league_name,
    nodeCount: counts.nodes,
    chunkCount: counts.chunks,
  };
}

/**
 * @param {Object} opts
 * @param {import('pg').PoolClient} opts.dbClient
 * @param {string} opts.leagueSlug
 * @param {string} [opts.season]
 * @param {Buffer} opts.pdfBuffer
 * @param {string} opts.filename
 * @param {import('openai').default} opts.openai
 * @param {(step: string, message: string) => void} [opts.onProgress]
 */
export async function runCanonicalIngestFromPdf(opts) {
  const {
    dbClient,
    leagueSlug,
    season = String(new Date().getFullYear()),
    pdfBuffer,
    filename,
    openai,
    onProgress = () => {},
  } = opts;

  const log = (step, message) => onProgress(step, message);

  const league = await resolveLeagueBySlug(dbClient, leagueSlug);
  log('league', `Resolved league ${league.name} (${league.slug})`);

  const sourceHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  log('hash', `Source SHA-256 ${sourceHash.slice(0, 16)}…`);

  const existing = await findDocumentByHash(dbClient, league.id, sourceHash);
  if (existing?.status === 'active') {
    throw new Error(
      `This exact file is already the active rulebook for ${leagueSlug} ` +
      `(version ${existing.version_id}). Upload a different file or retire the active version first.`,
    );
  }
  if (existing?.status === 'draft') {
    log('cleanup', `Removing prior draft version ${existing.version_id}`);
    await deleteDraftVersionCascade(dbClient, existing.version_id);
  }

  const { versionId, documentId } = await createDraftVersion({
    dbClient,
    leagueId: league.id,
    season,
    sourceHash,
    documentMeta: {
      source_file:  filename,
      mime_type:    'application/pdf',
      parse_method: 'pdf-parse-blocks',
    },
  });
  log('version', `Created draft version ${versionId}`);

  const adapterResult = await transformPdfToBlocks(pdfBuffer, {
    rulebookId: versionId,
    ruleDocumentId: documentId,
    filename,
  });
  log('extract', `Extracted ${adapterResult.pages.length} pages, ${adapterResult.metadata.blockCount} blocks`);

  const { extractionRunId, pageCount, blockCount } = await persistExtractionRun(
    dbClient,
    adapterResult,
    versionId,
    documentId,
    sourceHash,
  );
  log('persist', `Persisted extraction_run ${extractionRunId}`);

  const graph = await persistCanonicalGraph(dbClient, extractionRunId, versionId);
  log('canonicalize', `Built ${graph.nodeCount} nodes, ${graph.chunkCount} chunks (${graph.warningCount} warnings)`);

  if (graph.nodeCount === 0) {
    throw new Error('Canonicalization produced zero rule nodes — check PDF structure and heading patterns.');
  }

  const embed = await embedChunksForVersion(dbClient, versionId, openai, (done, total) => {
    log('embed', `Embedded ${done}/${total} chunk(s)`);
  });

  if (graph.zeroChunkNodeCount > 0) {
    throw new Error(
      `Cannot activate: ${graph.zeroChunkNodeCount} rule node(s) have body text but no search chunks. ` +
      `Resolve ZERO_CHUNKS warnings or run scripts/rechunk-missing-chunks.mjs before activation.`,
    );
  }

  const activation = await activateCanonicalVersion(dbClient, versionId);
  log('activate', `Activated version for ${activation.leagueSlug}`);

  return {
    success:           true,
    league_slug:       league.slug,
    league_name:       league.name,
    version_id:        versionId,
    document_id:       documentId,
    extraction_run_id: extractionRunId,
    page_count:        pageCount,
    block_count:       blockCount,
    node_count:        graph.nodeCount,
    chunk_count:       graph.chunkCount,
    warning_count:     graph.warningCount,
    blocking_warnings: graph.blockingWarningCount,
    embedded_count:    embed.embedded,
    status:            'active',
    source_hash:       sourceHash,
  };
}

export default {
  runCanonicalIngestFromPdf,
  persistExtractionRun,
  persistCanonicalGraph,
  embedChunksForVersion,
  activateCanonicalVersion,
};