/**
 * Ingestion integrity gates — ensure every rule with body_text has search chunks.
 */

export const ZERO_CHUNKS_WARNING_CODE = 'ZERO_CHUNKS';

/**
 * @param {import('pg').PoolClient|import('pg').Client} dbClient
 * @param {string} versionId
 */
export async function findZeroChunkNodes(dbClient, versionId) {
  const { rows } = await dbClient.query(`
    SELECT
      n.id,
      n.node_key,
      n.node_type,
      n.rule_number,
      n.title,
      n.extraction_run_id,
      length(trim(coalesce(n.body_text, '')))::int AS body_len
    FROM rule_nodes n
    WHERE n.rulebook_version_id = $1::uuid
      AND length(trim(coalesce(n.body_text, ''))) > 0
      AND NOT EXISTS (
        SELECT 1 FROM rule_node_chunks c WHERE c.rule_node_id = n.id
      )
    ORDER BY n.rule_number NULLS LAST, n.sort_order, n.node_key
  `, [versionId]);
  return rows;
}

/**
 * @param {Array<{ id: string, node_key: string, rule_number: string|null, title: string|null, body_len: number }>} nodes
 */
export function formatZeroChunkActivationError(nodes) {
  if (!nodes.length) return '';
  const labels = nodes.slice(0, 10).map((n) => {
    if (n.rule_number) return `Rule ${n.rule_number}`;
    if (n.title) return `${n.node_key} (${n.title})`;
    return n.node_key;
  }).join(', ');
  const more = nodes.length > 10 ? ` (+${nodes.length - 10} more)` : '';
  return (
    `Cannot activate: ${nodes.length} rule node(s) have body text but zero search chunks ` +
    `(${labels}${more}). Invisible rules cannot be retrieved. ` +
    `Run: node scripts/rechunk-missing-chunks.mjs --league=<slug>`
  );
}

/**
 * @param {import('pg').PoolClient|import('pg').Client} dbClient
 * @param {string} versionId
 */
export async function assertNoZeroChunkNodes(dbClient, versionId) {
  const nodes = await findZeroChunkNodes(dbClient, versionId);
  if (nodes.length) {
    throw new Error(formatZeroChunkActivationError(nodes));
  }
}

/**
 * @param {import('pg').PoolClient|import('pg').Client} dbClient
 * @param {string} versionId
 * @param {string} extractionRunId
 * @param {Array<Record<string, unknown>>} nodes
 */
export async function insertZeroChunkWarnings(dbClient, versionId, extractionRunId, nodes) {
  let inserted = 0;
  for (const node of nodes) {
    const label = node.rule_number ? `Rule ${node.rule_number}` : node.node_key;
    await dbClient.query(`
      INSERT INTO canonicalization_warnings (
        extraction_run_id, rulebook_version_id, rule_node_id,
        source_block_id, source_page_id,
        warning_code, severity, message, details, is_blocking
      ) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7::jsonb, $8)
    `, [
      extractionRunId,
      versionId,
      node.id,
      ZERO_CHUNKS_WARNING_CODE,
      'error',
      `${label} has ${node.body_len} character(s) of body text but no search chunks — invisible to retrieval.`,
      JSON.stringify({
        rule_number: node.rule_number,
        node_key: node.node_key,
        node_type: node.node_type,
        body_len: node.body_len,
      }),
      true,
    ]);
    inserted += 1;
  }
  return inserted;
}

/**
 * Scan a version and persist ZERO_CHUNKS warnings for offending nodes.
 *
 * @param {import('pg').PoolClient|import('pg').Client} dbClient
 * @param {string} versionId
 * @param {string} [extractionRunId]
 */
export async function auditZeroChunkIntegrity(dbClient, versionId, extractionRunId = null) {
  const nodes = await findZeroChunkNodes(dbClient, versionId);
  if (!nodes.length) {
    return { zeroChunkNodes: [], warningsInserted: 0 };
  }

  const runId = extractionRunId ?? nodes[0].extraction_run_id;
  if (!runId) {
    throw new Error(`Cannot audit zero-chunk integrity: no extraction_run_id for version ${versionId}`);
  }

  const warningsInserted = await insertZeroChunkWarnings(dbClient, versionId, runId, nodes);
  return { zeroChunkNodes: nodes, warningsInserted };
}

/**
 * @param {import('pg').PoolClient|import('pg').Client} dbClient
 * @param {string} versionId
 * @param {string[]} nodeIds
 * @param {string} [resolvedBy]
 */
export async function resolveZeroChunkWarnings(dbClient, versionId, nodeIds, resolvedBy = 'rechunk-missing-chunks') {
  if (!nodeIds.length) return 0;
  const { rowCount } = await dbClient.query(`
    UPDATE canonicalization_warnings
    SET resolved_at = now(),
        resolved_by = $3
    WHERE rulebook_version_id = $1::uuid
      AND resolved_at IS NULL
      AND warning_code = $4
      AND rule_node_id = ANY($2::uuid[])
  `, [versionId, nodeIds, resolvedBy, ZERO_CHUNKS_WARNING_CODE]);
  return rowCount ?? 0;
}

export default {
  ZERO_CHUNKS_WARNING_CODE,
  findZeroChunkNodes,
  formatZeroChunkActivationError,
  assertNoZeroChunkNodes,
  insertZeroChunkWarnings,
  auditZeroChunkIntegrity,
  resolveZeroChunkWarnings,
};
