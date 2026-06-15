#!/usr/bin/env node
/**
 * scripts/auto-merge-duplicates.mjs
 *
 * Consolidate duplicate rule nodes and merge multi-page continuation bodies
 * flagged by DUPLICATE_RULE / SHORT_BODY warnings, then re-chunk, embed, and
 * resolve associated QA warnings.
 *
 * Usage:
 *   node scripts/auto-merge-duplicates.mjs --league=mlb
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import OpenAI from 'openai';
import {
  cleanText,
  classifyHeading,
  firstLine,
  isBodyBlock,
} from '../lib/ingest/canonicalizer.js';
import { chunkBodyText } from '../lib/ingest/node-chunks.js';
import { embedChunksForVersion } from '../lib/ingest/canonical-pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHORT_BODY_THRESHOLD = 20;
const RESOLVED_BY = 'auto-merge-duplicates';

async function loadEnv() {
  for (const line of (await fs.readFile(path.join(__dirname, '../.env.local'), 'utf8')).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] ??= v;
  }
}

function parseLeagueArg(argv) {
  for (const arg of argv) {
    if (arg.startsWith('--league=')) return arg.slice('--league='.length).trim().toLowerCase();
  }
  return null;
}

function ruleBase(ruleNumber) {
  if (!ruleNumber) return null;
  return String(ruleNumber).match(/^\d{1,2}\.\d{2}/)?.[0] ?? String(ruleNumber);
}

function isPageNumberBlock(block) {
  return /^\d{1,3}$/.test(cleanText(block.exact_text));
}

function isDifferentRuleHeading(block, targetRuleNumber) {
  const targetBase = ruleBase(targetRuleNumber);
  const heading = classifyHeading(block);
  if (heading?.nodeType === 'rule' && heading.ruleNumber) {
    return ruleBase(heading.ruleNumber) !== targetBase;
  }

  const line = firstLine(block.exact_text).replace(/^Rule\s+/i, '');
  const m = line.match(/^(\d{1,2}\.\d{2})/);
  if (!m) return false;
  if (ruleBase(m[1]) === targetBase) return false;
  return line.length < 200;
}

function concatBodies(parts) {
  return parts
    .map(p => cleanText(p))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} leagueSlug
 */
async function resolveTargetVersion(client, leagueSlug) {
  const { rows } = await client.query(`
    SELECT rv.id, rv.status, rv.league_id,
           (SELECT er.id FROM extraction_runs er
             WHERE er.rulebook_version_id = rv.id
             ORDER BY er.completed_at DESC NULLS LAST
             LIMIT 1) AS extraction_run_id
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = $1
      AND rv.status IN ('active', 'draft')
    ORDER BY CASE rv.status WHEN 'active' THEN 0 ELSE 1 END, rv.updated_at DESC
    LIMIT 1
  `, [leagueSlug]);

  if (!rows.length) {
    throw new Error(`No active or draft rulebook version found for league "${leagueSlug}".`);
  }
  if (!rows[0].extraction_run_id) {
    throw new Error(`Version ${rows[0].id} has no extraction run.`);
  }
  return rows[0];
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} versionId
 */
async function findDuplicateNodeGroups(client, versionId) {
  const { rows: byRule } = await client.query(`
    SELECT rule_number AS group_key, 'rule_number' AS group_type, array_agg(id ORDER BY page_start, sort_order, char_start) AS node_ids
    FROM rule_nodes
    WHERE rulebook_version_id = $1
      AND node_type = 'rule'
      AND rule_number IS NOT NULL
    GROUP BY rule_number
    HAVING COUNT(*) > 1
  `, [versionId]);

  return byRule;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string[]} nodeIds
 */
async function fetchNodesByIds(client, nodeIds) {
  const { rows } = await client.query(`
    SELECT id, node_key, node_type, rule_number, title, body_text,
           page_start, page_end, char_start, char_end,
           source_block_ids, extraction_run_id, canonical_text
    FROM rule_nodes
    WHERE id = ANY($1::uuid[])
    ORDER BY page_start NULLS LAST, sort_order, char_start NULLS LAST
  `, [nodeIds]);
  return rows;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} keeperId
 * @param {string[]} duplicateIds
 */
async function reparentChildren(client, keeperId, duplicateIds) {
  if (!duplicateIds.length) return 0;
  const { rowCount } = await client.query(`
    UPDATE rule_nodes
    SET parent_id = $1::uuid, updated_at = now()
    WHERE parent_id = ANY($2::uuid[])
  `, [keeperId, duplicateIds]);
  return rowCount ?? 0;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {object} keeper
 * @param {object[]} duplicates
 */
async function mergeDuplicateNodeGroup(client, keeper, duplicates) {
  const bodies = [keeper.body_text, ...duplicates.map(d => d.body_text)];
  const blockIds = [
    ...(keeper.source_block_ids ?? []),
    ...duplicates.flatMap(d => d.source_block_ids ?? []),
  ];
  const uniqueBlockIds = [...new Set(blockIds)];

  const pageEnd = Math.max(
    keeper.page_end ?? 0,
    ...duplicates.map(d => d.page_end ?? 0),
  );
  const charEnd = Math.max(
    keeper.char_end ?? 0,
    ...duplicates.map(d => d.char_end ?? 0),
  );

  const mergedBody = concatBodies(bodies);
  const duplicateIds = duplicates.map(d => d.id);

  await reparentChildren(client, keeper.id, duplicateIds);

  await client.query(`
    UPDATE rule_nodes
    SET body_text = $1,
        source_block_ids = $2::uuid[],
        page_end = $3,
        char_end = $4,
        canonical_text = NULL,
        updated_at = now()
    WHERE id = $5::uuid
  `, [mergedBody, uniqueBlockIds, pageEnd || null, charEnd || null, keeper.id]);

  await client.query(`DELETE FROM rule_nodes WHERE id = ANY($1::uuid[])`, [duplicateIds]);

  return {
    keeperId: keeper.id,
    ruleNumber: keeper.rule_number,
    mergedCount: duplicates.length,
    bodyLength: mergedBody.length,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} extractionRunId
 */
async function loadBlocksInOrder(client, extractionRunId) {
  const { rows } = await client.query(`
    SELECT sb.id, sb.exact_text, sb.block_type, sb.block_index, sb.style_metadata,
           sb.char_offset_start, sb.char_offset_end,
           sp.page_number, sp.id AS source_page_id
    FROM source_blocks sb
    JOIN source_pages sp ON sp.id = sb.source_page_id
    WHERE sb.extraction_run_id = $1
    ORDER BY sp.page_number, sb.block_index
  `, [extractionRunId]);
  return rows;
}

/**
 * @param {object[]} blocks
 * @param {string} startBlockId
 * @param {string} targetRuleNumber
 * @param {Set<string>} existingBlockIds
 */
function collectContinuationBlocks(blocks, startBlockId, targetRuleNumber, existingBlockIds) {
  const startIdx = blocks.findIndex(b => b.id === startBlockId);
  if (startIdx < 0) return [];

  const collected = [];
  for (let i = startIdx + 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (isDifferentRuleHeading(block, targetRuleNumber)) break;
    if (isPageNumberBlock(block)) continue;

    const heading = classifyHeading(block);
    if (heading?.nodeType === 'rule' && ruleBase(heading.ruleNumber) === ruleBase(targetRuleNumber)) {
      continue;
    }

    if (!isBodyBlock(block) && !heading) continue;
    if (existingBlockIds.has(block.id)) continue;

    collected.push(block);
    existingBlockIds.add(block.id);
  }
  return collected;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} versionId
 * @param {string} extractionRunId
 * @param {object[]} blocks
 */
async function mergeDuplicateHeadingContinuations(client, versionId, extractionRunId, blocks) {
  const { rows: warnings } = await client.query(`
    SELECT id, rule_node_id, source_block_id, details
    FROM canonicalization_warnings
    WHERE rulebook_version_id = $1
      AND warning_code = 'DUPLICATE_RULE'
      AND resolved_at IS NULL
      AND rule_node_id IS NOT NULL
    ORDER BY rule_node_id, (details->>'page_number')::int NULLS LAST
  `, [versionId]);

  const byNode = new Map();
  for (const w of warnings) {
    if (!byNode.has(w.rule_node_id)) byNode.set(w.rule_node_id, []);
    byNode.get(w.rule_node_id).push(w);
  }

  const results = [];

  for (const [nodeId, nodeWarnings] of byNode) {
    const { rows: [node] } = await client.query(`
      SELECT id, rule_number, title, body_text, source_block_ids, page_start, page_end, char_end
      FROM rule_nodes WHERE id = $1
    `, [nodeId]);
    if (!node?.rule_number) continue;

    const existingBlockIds = new Set(node.source_block_ids ?? []);
    const appendBlocks = [];

    for (const warning of nodeWarnings) {
      if (!warning.source_block_id) continue;
      const collected = collectContinuationBlocks(
        blocks,
        warning.source_block_id,
        node.rule_number,
        existingBlockIds,
      );
      appendBlocks.push(...collected);
    }

    if (!appendBlocks.length) continue;

    const appendText = concatBodies(appendBlocks.map(b => b.exact_text));
    const mergedBody = concatBodies([node.body_text, appendText]);
    const newBlockIds = [
      ...(node.source_block_ids ?? []),
      ...appendBlocks.map(b => b.id),
    ];
    const pageEnd = Math.max(node.page_end ?? 0, ...appendBlocks.map(b => b.page_number));
    const charEnd = Math.max(
      node.char_end ?? 0,
      ...appendBlocks.map(b => b.char_offset_end ?? 0),
    );

    await client.query(`
      UPDATE rule_nodes
      SET body_text = $1,
          source_block_ids = $2::uuid[],
          page_end = $3,
          char_end = $4,
          canonical_text = NULL,
          updated_at = now()
      WHERE id = $5
    `, [mergedBody, newBlockIds, pageEnd || null, charEnd || null, nodeId]);

    results.push({
      nodeId,
      ruleNumber: node.rule_number,
      appendedBlocks: appendBlocks.length,
      bodyLength: mergedBody.length,
    });
  }

  return results;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} versionId
 * @param {object[]} blocks
 */
async function fixShortBodyNodes(client, versionId, blocks) {
  const { rows: warnings } = await client.query(`
    SELECT w.rule_node_id, rn.rule_number, rn.title, rn.body_text, rn.source_block_ids, rn.page_start
    FROM canonicalization_warnings w
    JOIN rule_nodes rn ON rn.id = w.rule_node_id
    WHERE w.rulebook_version_id = $1
      AND w.warning_code = 'SHORT_BODY'
      AND w.resolved_at IS NULL
  `, [versionId]);

  const blockById = new Map(blocks.map(b => [b.id, b]));
  const results = [];

  for (const row of warnings) {
    const sourceBlocks = (row.source_block_ids ?? [])
      .map(id => blockById.get(id))
      .filter(Boolean);

    let mergedBody = concatBodies(sourceBlocks.map(b => b.exact_text));
    const existingBlockIds = new Set(row.source_block_ids ?? []);

    if (mergedBody.length < SHORT_BODY_THRESHOLD && row.title) {
      mergedBody = concatBodies([row.title, row.body_text]);
    }

    if (mergedBody.length < SHORT_BODY_THRESHOLD) {
      const lastBlock = sourceBlocks.at(-1);
      const lastIdx = lastBlock ? blocks.findIndex(b => b.id === lastBlock.id) : -1;
      const collected = [];

      for (let i = Math.max(0, lastIdx + 1); i < blocks.length; i += 1) {
        const block = blocks[i];
        if (isDifferentRuleHeading(block, row.rule_number)) break;
        if (isPageNumberBlock(block)) continue;
        if (existingBlockIds.has(block.id)) continue;
        if (!isBodyBlock(block)) continue;
        collected.push(block);
        existingBlockIds.add(block.id);
        mergedBody = concatBodies([mergedBody, ...collected.map(b => b.exact_text)]);
        if (mergedBody.length >= SHORT_BODY_THRESHOLD) break;
      }
    }

    if (mergedBody.length < SHORT_BODY_THRESHOLD) continue;

    const newBlockIds = [...existingBlockIds];

    await client.query(`
      UPDATE rule_nodes
      SET body_text = $1,
          source_block_ids = $2::uuid[],
          canonical_text = NULL,
          updated_at = now()
      WHERE id = $3
    `, [mergedBody, newBlockIds, row.rule_node_id]);

    results.push({ nodeId: row.rule_node_id, ruleNumber: row.rule_number, bodyLength: mergedBody.length });
  }

  return results;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string[]} nodeIds
 * @param {string} extractionRunId
 */
async function rechunkNodes(client, nodeIds, extractionRunId) {
  if (!nodeIds.length) return 0;

  const { rows: nodes } = await client.query(`
    SELECT id, body_text FROM rule_nodes WHERE id = ANY($1::uuid[])
  `, [nodeIds]);

  await client.query(`DELETE FROM rule_node_chunks WHERE rule_node_id = ANY($1::uuid[])`, [nodeIds]);

  let chunkTotal = 0;
  for (const node of nodes) {
    const chunks = chunkBodyText(node.body_text);
    if (!chunks.length) {
      chunks.push(node.body_text ?? '');
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await client.query(`
        INSERT INTO rule_node_chunks (
          rule_node_id, extraction_run_id, chunk_index,
          chunk_text, char_start, char_end, source_block_ids
        ) VALUES ($1, $2, $3, $4, NULL, NULL, '{}'::uuid[])
      `, [node.id, extractionRunId, i, chunks[i]]);
      chunkTotal += 1;
    }
  }

  return chunkTotal;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} versionId
 * @param {string[]} nodeIds
 */
async function resolveWarningsForNodes(client, versionId, nodeIds) {
  const { rows: shortNodes } = await client.query(`
    SELECT id FROM rule_nodes
    WHERE id = ANY($1::uuid[])
      AND LENGTH(TRIM(COALESCE(body_text, ''))) >= $2
  `, [nodeIds, SHORT_BODY_THRESHOLD]);

  const shortIds = shortNodes.map(r => r.id);

  const { rowCount: dupCount } = await client.query(`
    UPDATE canonicalization_warnings
    SET resolved_at = now(), resolved_by = $2
    WHERE rulebook_version_id = $1
      AND resolved_at IS NULL
      AND warning_code = 'DUPLICATE_RULE'
  `, [versionId, RESOLVED_BY]);

  const { rowCount: shortCount } = await client.query(`
    UPDATE canonicalization_warnings
    SET resolved_at = now(), resolved_by = $3
    WHERE rulebook_version_id = $1
      AND resolved_at IS NULL
      AND warning_code = 'SHORT_BODY'
      AND (
        rule_node_id = ANY($2::uuid[])
        OR rule_node_id IN (
          SELECT id FROM rule_nodes
          WHERE rulebook_version_id = $1
            AND LENGTH(TRIM(COALESCE(body_text, ''))) >= $4
        )
      )
  `, [versionId, shortIds, RESOLVED_BY, SHORT_BODY_THRESHOLD]);

  return {
    duplicate_rules: dupCount ?? 0,
    short_body: shortCount ?? 0,
  };
}

async function countOpenWarnings(client, versionId, codes) {
  const { rows: [row] } = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM canonicalization_warnings
    WHERE rulebook_version_id = $1
      AND resolved_at IS NULL
      AND warning_code = ANY($2::text[])
  `, [versionId, codes]);
  return row?.c ?? 0;
}

async function main() {
  await loadEnv();

  const leagueSlug = parseLeagueArg(process.argv.slice(2));
  if (!leagueSlug) {
    console.error('Usage: node scripts/auto-merge-duplicates.mjs --league=<slug>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not configured.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not configured.');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const version = await resolveTargetVersion(client, leagueSlug);
    console.log(`[merge] league=${leagueSlug} version=${version.id} status=${version.status}`);

    const beforeDup = await countOpenWarnings(client, version.id, ['DUPLICATE_RULE', 'SHORT_BODY']);
    console.log(`[merge] open DUPLICATE_RULE + SHORT_BODY warnings before: ${beforeDup}`);

    const blocks = await loadBlocksInOrder(client, version.extraction_run_id);
    const affectedNodeIds = new Set();

    await client.query('BEGIN');

    const groups = await findDuplicateNodeGroups(client, version.id);
    console.log(`[merge] duplicate node groups: ${groups.length}`);

    for (const group of groups) {
      const nodes = await fetchNodesByIds(client, group.node_ids);
      if (nodes.length < 2) continue;
      const [keeper, ...duplicates] = nodes;
      const result = await mergeDuplicateNodeGroup(client, keeper, duplicates);
      affectedNodeIds.add(result.keeperId);
      console.log(`[merge] merged ${result.mergedCount + 1} nodes for ${group.group_type}=${group.group_key} → ${result.bodyLength} chars`);
    }

    const continuationResults = await mergeDuplicateHeadingContinuations(
      client,
      version.id,
      version.extraction_run_id,
      blocks,
    );
    for (const r of continuationResults) {
      affectedNodeIds.add(r.nodeId);
      console.log(`[merge] appended ${r.appendedBlocks} block(s) to rule ${r.ruleNumber} → ${r.bodyLength} chars`);
    }

    const shortResults = await fixShortBodyNodes(client, version.id, blocks);
    for (const r of shortResults) {
      affectedNodeIds.add(r.nodeId);
      console.log(`[merge] fixed SHORT_BODY rule ${r.ruleNumber} → ${r.bodyLength} chars`);
    }

    const nodeIdList = [...affectedNodeIds];
    const chunkTotal = await rechunkNodes(client, nodeIdList, version.extraction_run_id);
    console.log(`[merge] re-chunked ${nodeIdList.length} node(s) → ${chunkTotal} chunk(s)`);

    const embed = await embedChunksForVersion(client, version.id, openai, (done, total) => {
      if (done === total || done % 64 === 0) {
        console.log(`[merge] embedded ${done}/${total} chunk(s)`);
      }
    });
    console.log(`[merge] embedded ${embed.embedded} new chunk(s)`);

    const resolved = await resolveWarningsForNodes(client, version.id, nodeIdList);
    console.log(`[merge] resolved warnings: DUPLICATE_RULE=${resolved.duplicate_rules}, SHORT_BODY=${resolved.short_body}`);

    await client.query('COMMIT');

    const afterDup = await countOpenWarnings(client, version.id, ['DUPLICATE_RULE', 'SHORT_BODY']);
    console.log(`[merge] open DUPLICATE_RULE + SHORT_BODY warnings after: ${afterDup}`);

    if (afterDup > 0) {
      const { rows: remaining } = await client.query(`
        SELECT warning_code, COUNT(*)::int AS c
        FROM canonicalization_warnings
        WHERE rulebook_version_id = $1 AND resolved_at IS NULL
          AND warning_code IN ('DUPLICATE_RULE', 'SHORT_BODY')
        GROUP BY warning_code
      `, [version.id]);
      console.log('[merge] remaining breakdown:', remaining);
      process.exitCode = 1;
    } else {
      console.log('✓ DUPLICATE_RULE and SHORT_BODY warnings cleared.');
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[merge] failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
