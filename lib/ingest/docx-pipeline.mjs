/**
 * lib/ingest/docx-pipeline.mjs
 *
 * Streamlined DOCX ingestion: Markdown sections → rule_nodes → embeddings → activation.
 * Bypasses PDF adapters, source_blocks, canonicalizer, and TOC heuristics.
 */

import crypto from 'node:crypto';
import { createDraftVersion } from './write-rulebook-version.mjs';
import { parseDocxToGraph, DOCX_MIME } from './docx-markdown.mjs';
import {
  resolveLeagueBySlug,
  findDocumentByHash,
  deleteDraftVersionCascade,
  embedChunksForVersion,
  activateCanonicalVersion,
} from './canonical-pipeline.mjs';
import { assertNoZeroChunkNodes } from './integrity-gates.mjs';

export const DOCX_PIPELINE_VERSION = 'docx-markdown-v1';

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} slug
 * @param {string} displayName
 */
export async function ensureLeagueBySlug(dbClient, slug, displayName) {
  try {
    return await resolveLeagueBySlug(dbClient, slug);
  } catch {
    const name = displayName ?? slug.replace(/-/g, ' ');
    const { rows: [row] } = await dbClient.query(`
      INSERT INTO leagues (slug, name)
      VALUES ($1, $2)
      RETURNING id, slug, name
    `, [slug, name]);
    return row;
  }
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} versionId
 * @param {string} documentId
 * @param {string} sourceHash
 * @param {string} filename
 * @param {{ nodeCount: number, chunkCount: number }} counts
 */
async function createDocxExtractionRun(dbClient, versionId, documentId, sourceHash, filename, counts) {
  const runRes = await dbClient.query(`
    INSERT INTO extraction_runs (
      rulebook_version_id, rule_document_id,
      vendor, vendor_adapter, vendor_version, pipeline_version,
      status, input_mime_type, input_source_hash,
      page_count, block_count, metadata,
      started_at, completed_at
    ) VALUES (
      $1, $2,
      'mammoth', 'mammoth-turndown', '1.12', $3,
      'completed', $4, $5,
      1, 0, $6::jsonb,
      now(), now()
    )
    RETURNING id
  `, [
    versionId,
    documentId,
    DOCX_PIPELINE_VERSION,
    DOCX_MIME,
    sourceHash,
    JSON.stringify({
      filename,
      parse_method: 'mammoth-turndown',
      node_count: counts.nodeCount,
      chunk_count: counts.chunkCount,
    }),
  ]);

  return runRes.rows[0].id;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} extractionRunId
 * @param {string} versionId
 * @param {import('./docx-markdown.mjs').DocxCanonicalNode[]} nodes
 * @param {import('./docx-markdown.mjs').DocxCanonicalChunk[]} chunks
 */
export async function persistDocxGraph(dbClient, extractionRunId, versionId, nodes, chunks) {
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
        NULL, NULL, $12, $13,
        '{}'::uuid[], $14::jsonb
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
      node.char_start,
      node.char_end,
      JSON.stringify({ source: 'docx-markdown' }),
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
      ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::uuid[])
    `, [
      nodeId,
      extractionRunId,
      chunk.chunk_index,
      chunk.chunk_text,
      chunk.char_start,
      chunk.char_end,
    ]);
  }

  const { rows: [counts] } = await dbClient.query(`
    SELECT
      (SELECT COUNT(*)::int FROM rule_nodes WHERE rulebook_version_id = $1) AS nodes,
      (SELECT COUNT(*)::int FROM rule_node_chunks c
         JOIN rule_nodes n ON n.id = c.rule_node_id
        WHERE n.rulebook_version_id = $1) AS chunks
  `, [versionId]);

  return {
    nodeCount: counts.nodes,
    chunkCount: counts.chunks,
  };
}

/**
 * @param {Object} opts
 * @param {import('pg').PoolClient} opts.dbClient
 * @param {string} opts.leagueSlug
 * @param {string} [opts.leagueName]
 * @param {string} [opts.season]
 * @param {Buffer} opts.docxBuffer
 * @param {string} opts.filename
 * @param {import('openai').default} opts.openai
 * @param {boolean} [opts.allowDuplicateHash]
 * @param {(step: string, message: string) => void} [opts.onProgress]
 */
export async function runDocxIngest(opts) {
  const {
    dbClient,
    leagueSlug,
    leagueName,
    season = String(new Date().getFullYear()),
    docxBuffer,
    filename,
    openai,
    allowDuplicateHash = false,
    onProgress = () => {},
  } = opts;

  const log = (step, message) => onProgress(step, message);

  const league = await ensureLeagueBySlug(dbClient, leagueSlug, leagueName);
  log('league', `Resolved league ${league.name} (${league.slug})`);

  const sourceHash = crypto.createHash('sha256').update(docxBuffer).digest('hex');
  log('hash', `Source SHA-256 ${sourceHash.slice(0, 16)}…`);

  const existing = await findDocumentByHash(dbClient, league.id, sourceHash);
  if (existing?.status === 'active') {
    if (!allowDuplicateHash) {
      throw new Error(
        `This exact file is already the active rulebook for ${leagueSlug} ` +
        `(version ${existing.version_id}). Upload a different file or pass --allow-duplicate-hash.`,
      );
    }
    log('cleanup', `Retiring prior active version ${existing.version_id} (same hash, re-ingest requested)`);
    await dbClient.query(`
      UPDATE rulebook_versions SET status = 'retired', updated_at = now() WHERE id = $1
    `, [existing.version_id]);
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
      source_file: filename,
      mime_type: DOCX_MIME,
      parse_method: 'mammoth-turndown',
    },
  });
  log('version', `Created draft version ${versionId}`);

  const graph = await parseDocxToGraph(docxBuffer);
  log('parse', `Markdown ${graph.markdown.length} chars → ${graph.sections.length} sections`);

  if (!graph.nodes.length) {
    throw new Error('DOCX parse produced zero sections — check document structure.');
  }

  const extractionRunId = await createDocxExtractionRun(
    dbClient,
    versionId,
    documentId,
    sourceHash,
    filename,
    { nodeCount: graph.nodes.length, chunkCount: graph.chunks.length },
  );
  log('extract', `Created extraction_run ${extractionRunId}`);

  const persisted = await persistDocxGraph(
    dbClient,
    extractionRunId,
    versionId,
    graph.nodes,
    graph.chunks,
  );
  log('persist', `Saved ${persisted.nodeCount} nodes, ${persisted.chunkCount} chunks`);

  const embed = await embedChunksForVersion(dbClient, versionId, openai, (done, total) => {
    log('embed', `Embedded ${done}/${total} chunk(s)`);
  });

  await assertNoZeroChunkNodes(dbClient, versionId);

  const activation = await activateCanonicalVersion(dbClient, versionId);
  log('activate', `Activated version for ${activation.leagueSlug}`);

  return {
    success: true,
    league_slug: league.slug,
    league_name: league.name,
    version_id: versionId,
    document_id: documentId,
    extraction_run_id: extractionRunId,
    section_count: graph.sections.length,
    node_count: persisted.nodeCount,
    chunk_count: persisted.chunkCount,
    embedded_count: embed.embedded,
    status: 'active',
    source_hash: sourceHash,
    sample_sections: graph.sections.slice(0, 5).map((s) => ({
      level: s.level,
      title: s.title,
      rule_number: s.rule_number,
      body_chars: s.body_text.length,
    })),
  };
}

export default { runDocxIngest, parseDocxToGraph, persistDocxGraph };
