/**
 * lib/ingest/evidence-bundle.js
 *
 * Hybrid retrieval over rule_node_chunks and assembly of hierarchical
 * Evidence Bundles for the RAG drafter and verifier.
 */

// English stop words excluded from OR-fallback keyword extraction.
export const FTS_STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','dare','ought','used',
  'i','me','my','we','our','you','your','he','his','she','her','it','its',
  'they','their','them','this','that','these','those','who','which','what',
  'when','where','why','how','and','but','or','nor','for','yet','so',
  'in','on','at','to','of','by','from','up','about','into','through',
  'there','here','not','no','if','then','than','as','with','any','all',
  'rule','rules','ruling','rulings','league','leagues',
]);

/**
 * @param {string} question
 * @returns {string}
 */
export function buildOrFallbackQuery(question) {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !FTS_STOP_WORDS.has(w));
  return [...new Set(words)].join(' | ');
}

/**
 * @param {number[]} values
 * @returns {string}
 */
export function vectorLiteral(values) {
  return `[${values.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

/**
 * @param {Array<{ node_type: string, rule_number: string|null, title: string|null }>} ancestors oldest-first
 * @returns {string}
 */
export function formatAncestorPath(ancestors) {
  if (!ancestors?.length) return '';
  return ancestors.map(a => {
    const num = a.rule_number ? `${a.rule_number}. ` : '';
    const title = a.title ?? a.node_type;
    const label = a.node_type === 'chapter' ? `Chapter ${num}${title}` : `${capitalize(a.node_type)} ${num}${title}`;
    return label.trim();
  }).join(' → ');
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * @param {Object} node
 * @param {string} ancestorPath
 * @param {Array<{ node_type: string, title: string|null, body_text: string }>} children
 * @returns {string}
 */
export function buildCanonicalText(node, ancestorPath, children = []) {
  const parts = [];
  if (ancestorPath) parts.push(`Path: ${ancestorPath}`);
  if (node.rule_number && node.title) {
    parts.push(`Rule ${node.rule_number}: ${node.title}`);
  } else if (node.title) {
    parts.push(node.title);
  }
  const body = (node.body_text ?? '').trim();
  if (body) parts.push(body);

  for (const child of children) {
    const label = capitalize(child.node_type);
    const childTitle = child.title ? `${label}: ${child.title}` : label;
    const childBody = (child.body_text ?? '').trim();
    parts.push(childBody ? `${childTitle}\n${childBody}` : childTitle);
  }

  return parts.join('\n\n').trim();
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} ruleNodeId
 * @returns {Promise<Array<{ id: string, node_type: string, rule_number: string|null, title: string|null, depth: number }>>}
 */
export async function fetchAncestorChain(dbClient, ruleNodeId) {
  const { rows } = await dbClient.query(`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, node_type, rule_number, title, 0 AS depth
      FROM   rule_nodes
      WHERE  id = $1
      UNION ALL
      SELECT rn.id, rn.parent_id, rn.node_type, rn.rule_number, rn.title, chain.depth + 1
      FROM   rule_nodes rn
      JOIN   chain ON rn.id = chain.parent_id
    )
    SELECT id, node_type, rule_number, title, depth
    FROM   chain
    ORDER  BY depth DESC
  `, [ruleNodeId]);
  return rows;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} ruleNodeId
 */
export async function fetchChildAnnotations(dbClient, ruleNodeId) {
  const { rows } = await dbClient.query(`
    SELECT id, node_type, title, body_text, sort_order
    FROM   rule_nodes
    WHERE  parent_id = $1
      AND  node_type IN ('comment', 'exception', 'penalty')
    ORDER  BY sort_order ASC, created_at ASC
  `, [ruleNodeId]);
  return rows;
}

/**
 * Step A–C: hybrid chunk search → resolve rule nodes → assemble bundles.
 *
 * @param {import('pg').PoolClient} dbClient
 * @param {string} activeVersionId
 * @param {string} question
 * @param {{ queryEmbedding: string|null, limit?: number }} [opts]
 * @returns {Promise<{ bundles: Object[], method: string, chunkHits: Object[] }>}
 */
export async function fetchEvidenceBundles(dbClient, activeVersionId, question, opts = {}) {
  const limit = opts.limit ?? 3;
  const orTerms = buildOrFallbackQuery(question);
  const embedding = opts.queryEmbedding ?? null;

  const { rows: [run] } = await dbClient.query(`
    SELECT id
    FROM   extraction_runs
    WHERE  rulebook_version_id = $1
      AND  status = 'completed'
    ORDER  BY completed_at DESC NULLS LAST, created_at DESC
    LIMIT  1
  `, [activeVersionId]);

  if (!run) {
    return { bundles: [], method: 'evidence_no_extraction_run', chunkHits: [] };
  }

  /** @type {Array<Record<string, unknown>>} */
  let chunkHits = [];

  try {
    if (embedding) {
      const res = await dbClient.query(`
        WITH vector_candidates AS (
          SELECT
            c.id              AS chunk_id,
            c.rule_node_id,
            c.chunk_text,
            c.chunk_index,
            n.rule_number,
            n.title,
            n.node_type,
            n.body_text,
            n.page_start,
            n.page_end,
            1 - (c.embedding <=> $4::vector) AS vector_score,
            ts_rank(c.search_vector, plainto_tsquery('english', $1::text)) AS strict_fts_score,
            CASE
              WHEN $5::text = '' THEN 0
              ELSE ts_rank(c.search_vector, to_tsquery('english', $5::text))
            END AS or_fts_score
          FROM rule_node_chunks c
          JOIN rule_nodes n ON n.id = c.rule_node_id
          WHERE c.extraction_run_id = $2::uuid
            AND n.rulebook_version_id = $3::uuid
            AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> $4::vector
          LIMIT 24
        )
        SELECT *,
          (
            vector_score * 0.75 +
            greatest(strict_fts_score, or_fts_score) * 0.25 +
            CASE WHEN lower($1::text) LIKE '%' || lower(coalesce(rule_number, '')) || '%' THEN 0.15 ELSE 0 END
          ) AS hybrid_score
        FROM vector_candidates
        ORDER BY hybrid_score DESC, vector_score DESC
      `, [question, run.id, activeVersionId, embedding, orTerms]);
      chunkHits = res.rows;
    }

    if (chunkHits.length === 0) {
      const lexical = await dbClient.query(`
        SELECT
          c.id              AS chunk_id,
          c.rule_node_id,
          c.chunk_text,
          c.chunk_index,
          n.rule_number,
          n.title,
          n.node_type,
          n.body_text,
          n.page_start,
          n.page_end,
          greatest(
            ts_rank(c.search_vector, plainto_tsquery('english', $1::text)),
            CASE
              WHEN $4::text = '' THEN 0
              ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
            END
          ) AS hybrid_score,
          0::float8 AS vector_score,
          greatest(
            ts_rank(c.search_vector, plainto_tsquery('english', $1::text)),
            CASE
              WHEN $4::text = '' THEN 0
              ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
            END
          ) AS strict_fts_score,
          0::float8 AS or_fts_score
        FROM rule_node_chunks c
        JOIN rule_nodes n ON n.id = c.rule_node_id
        WHERE c.extraction_run_id = $2::uuid
          AND n.rulebook_version_id = $3::uuid
          AND (
            c.search_vector @@ plainto_tsquery('english', $1::text)
            OR ($4::text <> '' AND c.search_vector @@ to_tsquery('english', $4::text))
          )
        ORDER BY hybrid_score DESC
        LIMIT 24
      `, [question, run.id, activeVersionId, orTerms]);
      chunkHits = lexical.rows;
    }

    // Step B: dedupe to top rule_node_id matches
    const seenNodes = new Set();
    const topNodeHits = [];
    for (const hit of chunkHits) {
      if (seenNodes.has(hit.rule_node_id)) continue;
      seenNodes.add(hit.rule_node_id);
      topNodeHits.push(hit);
      if (topNodeHits.length >= limit) break;
    }

    // Step C: assemble Evidence Bundles
    const bundles = [];
    for (const hit of topNodeHits) {
      const { rows: [node] } = await dbClient.query(`
        SELECT id, node_type, rule_number, title, body_text, page_start, page_end, materialized_path
        FROM   rule_nodes
        WHERE  id = $1
      `, [hit.rule_node_id]);
      if (!node) continue;

      const ancestors = await fetchAncestorChain(dbClient, hit.rule_node_id);
      const ancestorPath = formatAncestorPath(ancestors.slice(0, -1));
      const children = await fetchChildAnnotations(dbClient, hit.rule_node_id);
      const canonicalText = buildCanonicalText(node, ancestorPath, children);

      bundles.push({
        bundle_id:        node.id,
        rule_node_id:     node.id,
        matched_chunk_id: hit.chunk_id,
        rule_number:      node.rule_number,
        title:            node.title,
        node_type:        node.node_type,
        ancestor_path:    ancestorPath,
        canonical_text:   canonicalText,
        page_start:       node.page_start,
        page_end:         node.page_end,
        hybrid_score:     Number(hit.hybrid_score ?? 0),
        vector_score:     Number(hit.vector_score ?? 0),
        matched_chunk_text: hit.chunk_text,
        annotations: children.map(c => ({
          node_type: c.node_type,
          title: c.title,
          body_text: c.body_text,
        })),
      });
    }

    const method = embedding && chunkHits.length > 0
      ? 'evidence_bundle_vector_hybrid'
      : (chunkHits.length > 0 ? 'evidence_bundle_fts' : 'evidence_bundle_no_match');

    return { bundles, method, chunkHits, extraction_run_id: run.id };
  } catch (err) {
    console.warn('[evidence-bundle] retrieval failed:', err.message);
    return { bundles: [], method: 'evidence_bundle_error', chunkHits: [], extraction_run_id: run.id };
  }
}

/**
 * @param {Object[]} bundles
 * @returns {string}
 */
export function formatEvidenceBundlesForPrompt(bundles) {
  if (!bundles.length) {
    return '(No matching evidence bundles found in the rulebook for this question. You must respond that no applicable rule was found.)';
  }

  return bundles.map((b, i) => {
    const page = b.page_start != null ? ` — p.${b.page_start}` : '';
    const ruleRef = b.rule_number ? `Rule ${b.rule_number}` : b.node_type;
    return `[Evidence Bundle ${i + 1}] ${ruleRef}${page}
Ancestor path: ${b.ancestor_path || '(root)'}
Canonical text:
"""${b.canonical_text}"""`;
  }).join('\n\n');
}

/**
 * @param {Object[]} bundles
 * @returns {string}
 */
export function formatEvidenceBundlesForVerifier(bundles) {
  if (!bundles.length) {
    return '(No evidence bundles were retrieved for this question.)';
  }

  return bundles.map(b => {
    const ruleRef = b.rule_number ?? b.node_type;
    return `[Bundle ${b.bundle_id}]
Rule ${ruleRef}:
"""${b.canonical_text}"""`;
  }).join('\n\n');
}

export default {
  fetchEvidenceBundles,
  formatEvidenceBundlesForPrompt,
  formatEvidenceBundlesForVerifier,
  buildOrFallbackQuery,
  vectorLiteral,
  buildCanonicalText,
  formatAncestorPath,
};
