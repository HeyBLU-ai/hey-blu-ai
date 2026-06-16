/**
 * lib/ingest/evidence-bundle.js
 *
 * Hybrid retrieval over rule_node_chunks and assembly of hierarchical
 * Evidence Bundles for the RAG drafter and verifier.
 */

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

/** Default hybrid_score below which local retrieval triggers fallback rulebook search. */
export const DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD = 0.30;

/** Independent candidate pool size per retrieval path (vector + FTS). */
export const RETRIEVAL_CANDIDATE_LIMIT = 24;

/** Reciprocal Rank Fusion smoothing constant (standard k=60). */
export const RRF_K = 60;

/**
 * @param {Object[]} bundles
 * @returns {number}
 */
export function bestEvidenceScore(bundles) {
  if (!bundles?.length) return 0;
  return Math.max(...bundles.map(b => Number(b.hybrid_score ?? 0)));
}

/**
 * @param {string} question
 * @returns {string[]}
 */
export function extractQueryPhrases(question) {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !FTS_STOP_WORDS.has(w));

  const phrases = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  for (let i = 0; i < tokens.length - 2; i++) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return [...new Set(phrases)];
}

/**
 * @param {Object} bundle
 * @returns {string}
 */
function bundleSearchText(bundle) {
  return [
    bundle.title,
    bundle.matched_chunk_text,
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * @param {Object[]} bundles
 * @returns {Object|null}
 */
export function topScoringBundle(bundles) {
  if (!bundles?.length) return null;
  return [...bundles].sort(
    (a, b) => Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0),
  )[0];
}

/**
 * @param {Object} bundle
 * @param {string[]} phrases
 * @returns {boolean}
 */
export function bundleHasPhraseCoverage(bundle, phrases) {
  if (!bundle || !phrases?.length) return false;
  const text = bundleSearchText(bundle);
  return phrases.some((p) => text.includes(p));
}

/**
 * @param {string} question
 * @param {string|null|undefined} ruleNumber
 * @returns {boolean}
 */
export function questionReferencesRuleNumber(question, ruleNumber) {
  const raw = String(ruleNumber ?? '').trim().replace(/\*+/g, '');
  if (!raw || raw === '—' || /^rule$/i.test(raw)) return false;

  const q = question.toLowerCase();
  const rule = raw.toLowerCase();

  if (/^pr-\d+$/i.test(raw)) {
    return new RegExp(`\\b${rule.replace('-', '\\-')}\\b`, 'i').test(q);
  }

  if (/^\d+\.\d+/.test(raw)) {
    const core = rule.split(/[([\s]/)[0];
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (core.length < 2) {
      return new RegExp(`\\brule\\s+${escaped}\\b`, 'i').test(q);
    }
    return (
      new RegExp(`\\b${escaped}\\b`, 'i').test(q)
      || new RegExp(`\\brule\\s+${escaped}\\b`, 'i').test(q)
    );
  }

  if (/^\d+$/.test(raw)) {
    if (raw.length < 2) {
      return new RegExp(`\\brule\\s+${rule}\\b`, 'i').test(q);
    }
    return (
      new RegExp(`\\b${rule}\\b`, 'i').test(q)
      || new RegExp(`\\brule\\s+${rule}\\b`, 'i').test(q)
    );
  }

  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(q);
}

/**
 * @param {Object[]} bundles
 * @param {number} [threshold]
 * @param {string|null} [question]
 * @returns {boolean}
 */
export function shouldUseFallbackRulebook(
  bundles,
  threshold = DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
  question = null,
) {
  if (!bundles?.length) return true;
  if (bestEvidenceScore(bundles) < threshold) return true;

  if (!question) return false;

  const phrases = extractQueryPhrases(question);
  if (!phrases.length) return false;

  const top = topScoringBundle(bundles);
  if (!top) return true;

  return !bundleHasPhraseCoverage(top, phrases);
}

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
 * @param {number} vectorScore
 * @param {number} strictFts
 * @param {number} orFts
 * @param {string} question
 * @param {string|null|undefined} ruleNumber
 */
export function computeHybridScore(vectorScore, strictFts, orFts, question, ruleNumber) {
  const fts = Math.max(Number(strictFts ?? 0), Number(orFts ?? 0));
  const ruleBoost = questionReferencesRuleNumber(question, ruleNumber) ? 0.15 : 0;
  return Number(vectorScore ?? 0) * 0.75 + fts * 0.25 + ruleBoost;
}

/**
 * Union vector + FTS candidate lists, apply hybrid score and RRF tie-break.
 *
 * @param {Array<Record<string, unknown>>} vectorHits
 * @param {Array<Record<string, unknown>>} ftsHits
 * @param {string} question
 */
export function mergeDualPathChunkHits(vectorHits, ftsHits, question) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byChunkId = new Map();

  vectorHits.forEach((hit, idx) => {
    byChunkId.set(hit.chunk_id, {
      ...hit,
      vector_rank: idx + 1,
      fts_rank: null,
      retrieval_paths: ['vector'],
    });
  });

  ftsHits.forEach((hit, idx) => {
    const existing = byChunkId.get(hit.chunk_id);
    if (existing) {
      existing.fts_rank = idx + 1;
      existing.strict_fts_score = Math.max(
        Number(existing.strict_fts_score ?? 0),
        Number(hit.strict_fts_score ?? 0),
      );
      existing.or_fts_score = Math.max(
        Number(existing.or_fts_score ?? 0),
        Number(hit.or_fts_score ?? 0),
      );
      if (!existing.retrieval_paths.includes('fts')) {
        existing.retrieval_paths.push('fts');
      }
      if (Number(hit.vector_score ?? 0) > Number(existing.vector_score ?? 0)) {
        existing.vector_score = hit.vector_score;
      }
    } else {
      byChunkId.set(hit.chunk_id, {
        ...hit,
        vector_rank: null,
        fts_rank: idx + 1,
        retrieval_paths: ['fts'],
      });
    }
  });

  const merged = [...byChunkId.values()].map((hit) => {
    const vectorScore = Number(hit.vector_score ?? 0);
    const strictFts = Number(hit.strict_fts_score ?? 0);
    const orFts = Number(hit.or_fts_score ?? 0);
    const hybridScore = computeHybridScore(vectorScore, strictFts, orFts, question, hit.rule_number);
    const rrfVector = hit.vector_rank ? 1 / (RRF_K + hit.vector_rank) : 0;
    const rrfFts = hit.fts_rank ? 1 / (RRF_K + hit.fts_rank) : 0;
    const rrfScore = rrfVector + rrfFts;

    return {
      ...hit,
      hybrid_score: hybridScore,
      rrf_score: rrfScore,
    };
  });

  merged.sort((a, b) => {
    const scoreDiff = Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(b.rrf_score ?? 0) - Number(a.rrf_score ?? 0);
  });

  return merged;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {{ question: string, extractionRunId: string, versionId: string, embedding: string, orTerms: string, limit?: number }} params
 */
async function fetchVectorChunkCandidates(dbClient, params) {
  const { question, extractionRunId, versionId, embedding, orTerms, limit = RETRIEVAL_CANDIDATE_LIMIT } = params;
  const { rows } = await dbClient.query(`
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
    LIMIT $6
  `, [question, extractionRunId, versionId, embedding, orTerms, limit]);
  return rows;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {{ question: string, extractionRunId: string, versionId: string, orTerms: string, embedding?: string|null, limit?: number }} params
 */
async function fetchFtsChunkCandidates(dbClient, params) {
  const {
    question,
    extractionRunId,
    versionId,
    orTerms,
    embedding = null,
    limit = RETRIEVAL_CANDIDATE_LIMIT,
  } = params;

  if (embedding) {
    const { rows } = await dbClient.query(`
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
        1 - (c.embedding <=> $5::vector) AS vector_score,
        ts_rank(c.search_vector, plainto_tsquery('english', $1::text)) AS strict_fts_score,
        CASE
          WHEN $4::text = '' THEN 0
          ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
        END AS or_fts_score,
        greatest(
          ts_rank(c.search_vector, plainto_tsquery('english', $1::text)),
          CASE
            WHEN $4::text = '' THEN 0
            ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
          END
        ) AS fts_rank_score
      FROM rule_node_chunks c
      JOIN rule_nodes n ON n.id = c.rule_node_id
      WHERE c.extraction_run_id = $2::uuid
        AND n.rulebook_version_id = $3::uuid
        AND (
          c.search_vector @@ plainto_tsquery('english', $1::text)
          OR ($4::text <> '' AND c.search_vector @@ to_tsquery('english', $4::text))
        )
      ORDER BY fts_rank_score DESC, vector_score DESC
      LIMIT $6
    `, [question, extractionRunId, versionId, orTerms, embedding, limit]);
    return rows;
  }

  const { rows } = await dbClient.query(`
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
      0::float8         AS vector_score,
      ts_rank(c.search_vector, plainto_tsquery('english', $1::text)) AS strict_fts_score,
      CASE
        WHEN $4::text = '' THEN 0
        ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
      END AS or_fts_score,
      greatest(
        ts_rank(c.search_vector, plainto_tsquery('english', $1::text)),
        CASE
          WHEN $4::text = '' THEN 0
          ELSE ts_rank(c.search_vector, to_tsquery('english', $4::text))
        END
      ) AS fts_rank_score
    FROM rule_node_chunks c
    JOIN rule_nodes n ON n.id = c.rule_node_id
    WHERE c.extraction_run_id = $2::uuid
      AND n.rulebook_version_id = $3::uuid
      AND (
        c.search_vector @@ plainto_tsquery('english', $1::text)
        OR ($4::text <> '' AND c.search_vector @@ to_tsquery('english', $4::text))
      )
    ORDER BY fts_rank_score DESC
    LIMIT $5
  `, [question, extractionRunId, versionId, orTerms, limit]);
  return rows;
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
export async function fetchAncestorChain(dbClient, ruleNodeId, rulebookVersionId = null) {
  const versionClause = rulebookVersionId
    ? `AND rn.rulebook_version_id = $2::uuid`
    : '';
  const params = rulebookVersionId ? [ruleNodeId, rulebookVersionId] : [ruleNodeId];
  const { rows } = await dbClient.query(`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, node_type, rule_number, title, rulebook_version_id, 0 AS depth
      FROM   rule_nodes
      WHERE  id = $1
      ${rulebookVersionId ? 'AND rulebook_version_id = $2::uuid' : ''}
      UNION ALL
      SELECT rn.id, rn.parent_id, rn.node_type, rn.rule_number, rn.title, rn.rulebook_version_id, chain.depth + 1
      FROM   rule_nodes rn
      JOIN   chain ON rn.id = chain.parent_id
      ${versionClause}
    )
    SELECT id, node_type, rule_number, title, depth
    FROM   chain
    ORDER  BY depth DESC
  `, params);
  return rows;
}

/**
 * @param {import('pg').PoolClient} dbClient
 * @param {string} ruleNodeId
 */
export async function fetchChildAnnotations(dbClient, ruleNodeId, rulebookVersionId = null) {
  const params = rulebookVersionId ? [ruleNodeId, rulebookVersionId] : [ruleNodeId];
  const { rows } = await dbClient.query(`
    SELECT id, node_type, title, body_text, sort_order
    FROM   rule_nodes
    WHERE  parent_id = $1
      AND  node_type IN ('comment', 'exception', 'penalty')
      ${rulebookVersionId ? 'AND rulebook_version_id = $2::uuid' : ''}
    ORDER  BY sort_order ASC, created_at ASC
  `, params);
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
      const [vectorHits, ftsHits] = await Promise.all([
        fetchVectorChunkCandidates(dbClient, {
          question,
          extractionRunId: run.id,
          versionId: activeVersionId,
          embedding,
          orTerms,
        }),
        fetchFtsChunkCandidates(dbClient, {
          question,
          extractionRunId: run.id,
          versionId: activeVersionId,
          orTerms,
          embedding,
        }),
      ]);
      chunkHits = mergeDualPathChunkHits(vectorHits, ftsHits, question);
    } else {
      const ftsHits = await fetchFtsChunkCandidates(dbClient, {
        question,
        extractionRunId: run.id,
        versionId: activeVersionId,
        orTerms,
      });
      chunkHits = ftsHits.map((hit) => ({
        ...hit,
        retrieval_paths: ['fts'],
        hybrid_score: computeHybridScore(
          0,
          hit.strict_fts_score,
          hit.or_fts_score,
          question,
          hit.rule_number,
        ),
        rrf_score: 0,
      })).sort((a, b) => Number(b.hybrid_score ?? 0) - Number(a.hybrid_score ?? 0));
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
          AND  rulebook_version_id = $2::uuid
      `, [hit.rule_node_id, activeVersionId]);
      if (!node) continue;

      const ancestors = await fetchAncestorChain(dbClient, hit.rule_node_id, activeVersionId);
      const ancestorPath = formatAncestorPath(ancestors.slice(0, -1));
      const children = await fetchChildAnnotations(dbClient, hit.rule_node_id, activeVersionId);
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
        rulebook_source:  opts.rulebookSource ?? 'primary',
        annotations: children.map(c => ({
          node_type: c.node_type,
          title: c.title,
          body_text: c.body_text,
        })),
      });
    }

    const method = embedding && chunkHits.length > 0
      ? 'evidence_bundle_dual_path_hybrid'
      : (chunkHits.length > 0 ? 'evidence_bundle_fts' : 'evidence_bundle_no_match');

    return { bundles, method, chunkHits, extraction_run_id: run.id };
  } catch (err) {
    console.warn('[evidence-bundle] retrieval failed:', err.message);
    return { bundles: [], method: 'evidence_bundle_error', chunkHits: [], extraction_run_id: run.id };
  }
}

/**
 * Search the primary rulebook, then the configured fallback rulebook when local
 * chunk scores fall below the threshold.
 *
 * @param {import('pg').PoolClient} dbClient
 * @param {string} primaryVersionId
 * @param {string} question
 * @param {{
 *   queryEmbedding?: string|null,
 *   limit?: number,
 *   fallbackVersionId?: string|null,
 *   scoreThreshold?: number,
 * }} [opts]
 */
export async function fetchEvidenceBundlesWithFallback(dbClient, primaryVersionId, question, opts = {}) {
  const {
    fallbackVersionId = null,
    scoreThreshold = DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
    ...searchOpts
  } = opts;

  const primary = await fetchEvidenceBundles(dbClient, primaryVersionId, question, {
    ...searchOpts,
    rulebookSource: 'primary',
  });

  const primaryBestScore = bestEvidenceScore(primary.bundles);
  const needsFallback = Boolean(
    fallbackVersionId &&
    fallbackVersionId !== primaryVersionId &&
    shouldUseFallbackRulebook(primary.bundles, scoreThreshold, question),
  );

  if (!needsFallback) {
    return {
      ...primary,
      usedFallback:       false,
      primaryBestScore,
      fallbackBestScore:  null,
      scoreThreshold,
    };
  }

  const fallback = await fetchEvidenceBundles(dbClient, fallbackVersionId, question, {
    ...searchOpts,
    rulebookSource: 'fallback',
  });

  const fallbackBestScore = bestEvidenceScore(fallback.bundles);

  return {
    bundles:            fallback.bundles,
    chunkHits:          fallback.chunkHits,
    extraction_run_id:  fallback.extraction_run_id,
    method:             `fallback_${fallback.method}`,
    usedFallback:       true,
    primaryMethod:      primary.method,
    primaryBestScore,
    fallbackBestScore,
    scoreThreshold,
    fallbackVersionId,
  };
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
  fetchEvidenceBundlesWithFallback,
  formatEvidenceBundlesForPrompt,
  formatEvidenceBundlesForVerifier,
  buildOrFallbackQuery,
  computeHybridScore,
  mergeDualPathChunkHits,
  vectorLiteral,
  buildCanonicalText,
  formatAncestorPath,
  bestEvidenceScore,
  topScoringBundle,
  bundleHasPhraseCoverage,
  extractQueryPhrases,
  questionReferencesRuleNumber,
  shouldUseFallbackRulebook,
  DEFAULT_EVIDENCE_FALLBACK_SCORE_THRESHOLD,
  RETRIEVAL_CANDIDATE_LIMIT,
  RRF_K,
};
