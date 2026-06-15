/**
 * Rebuild rule_node_chunks from consolidated body_text.
 */

import { chunkBodyText } from './node-chunks.js';

/**
 * @param {import('pg').PoolClient|import('pg').Client} client
 * @param {string[]} nodeIds
 * @param {string} extractionRunId
 * @returns {Promise<number>}
 */
export async function rechunkNodes(client, nodeIds, extractionRunId) {
  if (!nodeIds.length) return 0;

  const { rows: nodes } = await client.query(`
    SELECT id, body_text FROM rule_nodes WHERE id = ANY($1::uuid[])
  `, [nodeIds]);

  await client.query(
    `DELETE FROM rule_node_chunks WHERE rule_node_id = ANY($1::uuid[])`,
    [nodeIds],
  );

  let chunkTotal = 0;
  for (const node of nodes) {
    const text = (node.body_text ?? '').trim();
    if (!text) continue;

    const chunks = chunkBodyText(text);
    const parts = chunks.length ? chunks : [text];

    for (let i = 0; i < parts.length; i += 1) {
      await client.query(`
        INSERT INTO rule_node_chunks (
          rule_node_id, extraction_run_id, chunk_index,
          chunk_text, char_start, char_end, source_block_ids
        ) VALUES ($1, $2, $3, $4, NULL, NULL, '{}'::uuid[])
      `, [node.id, extractionRunId, i, parts[i]]);
      chunkTotal += 1;
    }
  }

  return chunkTotal;
}

export default { rechunkNodes };
