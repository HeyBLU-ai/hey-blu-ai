/**
 * lib/ingest/docx-pipeline.mjs
 *
 * Streamlined DOCX ingestion: Markdown sections → rule_nodes → embeddings → activation.
 * Bypasses PDF adapters, source_blocks, canonicalizer, and TOC heuristics.
 *
 * Transactions are split so OpenAI embedding calls never run inside a DB transaction.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { createDraftVersion } from './write-rulebook-version.mjs';
import { parseDocxToGraph, DOCX_MIME } from './docx-markdown.mjs';
import {
  resolveLeagueBySlug,
  findDocumentByHash,
  deleteDraftVersionCascade,
  activateCanonicalVersion,
} from './canonical-pipeline.mjs';
import { assertNoZeroChunkNodes } from './integrity-gates.mjs';

const { Client } = pg;

export const DOCX_PIPELINE_VERSION = 'docx-markdown-v1';

export const DOCX_PARSE_LIMITS = {
  maxMarkdownChars: 50_000,
  maxNodes: 500,
  maxChunks: 1_500,
};

const EMBED_BATCH_SIZE = 64;
const EMBED_TIMEOUT_MS = 60_000;
const EMBED_MAX_RETRIES = 3;
const EMBED_RETRY_BASE_MS = 1_000;

function vectorLiteral(values) {
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

function embeddingInput(row) {
  return [
    row.rule_number ? `Rule ${row.rule_number}` : null,
    row.title ? `Title: ${row.title}` : null,
    row.chunk_text,
  ].filter(Boolean).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('./docx-markdown.mjs').ReturnType<typeof parseDocxToGraph> extends Promise<infer T> ? T : never} graph
 */
export function assertDocxGraphBounds(graph) {
  const { maxMarkdownChars, maxNodes, maxChunks } = DOCX_PARSE_LIMITS;

  if (graph.markdown.length > maxMarkdownChars) {
    throw new Error(
      `DOCX exceeds ${maxMarkdownChars.toLocaleString()} total structural markdown characters ` +
      `(${graph.markdown.length.toLocaleString()} parsed).`,
    );
  }
  if (graph.nodes.length > maxNodes) {
    throw new Error(
      `DOCX exceeds ${maxNodes} parsed rule nodes (${graph.nodes.length} found).`,
    );
  }
  if (graph.chunks.length > maxChunks) {
    throw new Error(
      `DOCX exceeds ${maxChunks} chunks (${graph.chunks.length} found).`,
    );
  }
  if (!graph.nodes.length) {
    throw new Error('DOCX parse produced zero sections — check document structure.');
  }
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} slug
 * @param {string} [displayName]
 */
export async function ensureLeagueBySlug(dbClient, slug, displayName) {
  const name = displayName ?? slug.replace(/-/g, ' ');

  const { rows: inserted } = await dbClient.query(`
    INSERT INTO leagues (slug, name)
    VALUES ($1, $2)
    ON CONFLICT (slug) DO NOTHING
    RETURNING id, slug, name
  `, [slug, name]);

  if (inserted.length) return inserted[0];

  const { rows: existing } = await dbClient.query(
    `SELECT id, slug, name FROM leagues WHERE slug = $1`,
    [slug],
  );
  if (!existing.length) {
    throw new Error(`Failed to resolve league "${slug}" after upsert.`);
  }
  return existing[0];
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
 * @param {import('openai').default} openai
 * @param {Object} params
 */
async function createEmbeddingsWithRetry(openai, params) {
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  let lastError;

  for (let attempt = 1; attempt <= EMBED_MAX_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
      const result = await openai.embeddings.create(
        { model, dimensions: 1536, ...params },
        { signal: controller.signal },
      );
      clearTimeout(timer);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < EMBED_MAX_RETRIES) {
        await sleep(EMBED_RETRY_BASE_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error('Embedding request failed after retries');
}

/**
 * OpenAI embedding phase — uses its own DB connections, never inside a transaction.
 *
 * @param {string} connectionString
 * @param {string} versionId
 * @param {import('openai').default} openai
 * @param {(embedded: number, total: number) => void} [onBatch]
 */
export async function embedChunksOutOfTransaction(connectionString, versionId, openai, onBatch) {
  const ssl = { rejectUnauthorized: false };
  const readClient = new Client({ connectionString, ssl });

  try {
    await readClient.connect();
    const { rows: chunks } = await readClient.query(`
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
      const result = await createEmbeddingsWithRetry(openai, {
        input: batch.map(embeddingInput),
      });

      if (!result.data || result.data.length !== batch.length) {
        throw new Error(`Embedding batch returned ${result.data?.length ?? 0}/${batch.length} vectors`);
      }

      const byIndex = new Map(result.data.map((row) => [row.index, row.embedding]));

      const writeClient = new Client({ connectionString, ssl });
      try {
        await writeClient.connect();
        await writeClient.query('BEGIN');

        for (let j = 0; j < batch.length; j += 1) {
          const chunk = batch[j];
          const embedding = byIndex.get(j);
          if (!embedding || embedding.length !== 1536) {
            throw new Error(`Invalid embedding for chunk ${chunk.id}`);
          }
          await writeClient.query(
            `UPDATE rule_node_chunks SET embedding = $1::vector WHERE id = $2`,
            [vectorLiteral(embedding), chunk.id],
          );
          embedded += 1;
        }

        await writeClient.query('COMMIT');
      } catch (err) {
        try { await writeClient.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        try { await writeClient.end(); } catch { /* ignore */ }
      }

      onBatch?.(embedded, total);
    }

    return { embedded, pending: total };
  } finally {
    try { await readClient.end(); } catch { /* ignore */ }
  }
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} leagueSlug
 * @param {string} versionId
 */
async function activateDocxVersionInTransaction(dbClient, leagueSlug, versionId) {
  await dbClient.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [leagueSlug],
  );
  await assertNoZeroChunkNodes(dbClient, versionId);
  return activateCanonicalVersion(dbClient, versionId);
}

/**
 * @param {Object} opts
 * @param {import('pg').PoolClient} opts.dbClient
 * @param {string} [opts.connectionString]
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
    connectionString = process.env.DATABASE_URL,
    leagueSlug,
    leagueName,
    season = String(new Date().getFullYear()),
    docxBuffer,
    filename,
    openai,
    allowDuplicateHash = false,
    onProgress = () => {},
  } = opts;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for DOCX ingest');
  }

  const log = (step, message) => onProgress(step, message);

  const graph = await parseDocxToGraph(docxBuffer);
  assertDocxGraphBounds(graph);
  log('parse', `Markdown ${graph.markdown.length} chars → ${graph.sections.length} sections`);

  const sourceHash = crypto.createHash('sha256').update(docxBuffer).digest('hex');

  let league;
  let versionId;
  let documentId;
  let extractionRunId;
  let persisted;

  // Transaction 1: league, dedupe, draft graph — commit before any network I/O.
  await dbClient.query('BEGIN');
  try {
    league = await ensureLeagueBySlug(dbClient, leagueSlug, leagueName);
    log('league', `Resolved league ${league.name} (${league.slug})`);
    log('hash', `Source SHA-256 ${sourceHash.slice(0, 16)}…`);

    if (leagueName) {
      await dbClient.query(`
        UPDATE leagues SET name = $1, updated_at = now()
        WHERE id = $2 AND name IS DISTINCT FROM $1
      `, [leagueName, league.id]);
      league.name = leagueName;
    }

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

    ({ versionId, documentId } = await createDraftVersion({
      dbClient,
      leagueId: league.id,
      season,
      sourceHash,
      documentMeta: {
        source_file: filename,
        mime_type: DOCX_MIME,
        parse_method: 'mammoth-turndown',
      },
    }));
    log('version', `Created draft version ${versionId}`);

    extractionRunId = await createDocxExtractionRun(
      dbClient,
      versionId,
      documentId,
      sourceHash,
      filename,
      { nodeCount: graph.nodes.length, chunkCount: graph.chunks.length },
    );
    log('extract', `Created extraction_run ${extractionRunId}`);

    persisted = await persistDocxGraph(
      dbClient,
      extractionRunId,
      versionId,
      graph.nodes,
      graph.chunks,
    );
    log('persist', `Saved ${persisted.nodeCount} nodes, ${persisted.chunkCount} chunks`);

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  // Out-of-transaction: OpenAI embedding with timeouts and bounded retries.
  const embed = await embedChunksOutOfTransaction(
    connectionString,
    versionId,
    openai,
    (done, total) => log('embed', `Embedded ${done}/${total} chunk(s)`),
  );

  // Transaction 2: per-league advisory lock, validate, retire prior active, activate.
  let activation;
  await dbClient.query('BEGIN');
  try {
    activation = await activateDocxVersionInTransaction(dbClient, leagueSlug, versionId);
    log('activate', `Activated version for ${activation.leagueSlug}`);
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

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

export default {
  runDocxIngest,
  parseDocxToGraph,
  persistDocxGraph,
  assertDocxGraphBounds,
  embedChunksOutOfTransaction,
  DOCX_PARSE_LIMITS,
};
