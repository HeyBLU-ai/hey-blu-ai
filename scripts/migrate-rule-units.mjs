/**
 * Build canonical rule_units from existing V3 rule atom/source-span data.
 *
 * This is intentionally additive: it does not delete or rewrite rule_sources,
 * rules, or rule_source_links. It creates a retrieval-ready table where each
 * row is a complete citeable rule unit rather than a fragmented source span.
 *
 * Usage:
 *   node scripts/migrate-rule-units.mjs
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  } catch {
    // Vercel/CI can provide env directly.
  }
}

loadLocalEnv();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function normalizeRuleNumber(value) {
  const text = (value ?? '').trim();
  if (!text || text === '-' || text.toLowerCase() === 'unnumbered') return null;
  return text;
}

function cleanText(value) {
  return (value ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueByText(spans) {
  const seen = new Set();
  const out = [];
  for (const span of spans) {
    const text = cleanText(span.exact_text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ ...span, exact_text: text });
  }
  return out;
}

function chooseTitle(rules, ruleNumber) {
  const normalizedHeading = new RegExp(`^${ruleNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?\\s*`, 'i');
  const candidates = rules
    .map(r => cleanText(r.title))
    .filter(Boolean)
    .map(t => t.replace(normalizedHeading, '').trim())
    .filter(Boolean);

  if (candidates.length === 0) return null;
  // Prefer concise section titles over long generated descriptions.
  return candidates.sort((a, b) => a.length - b.length)[0];
}

function assembleFullText(ruleNumber, title, spans) {
  const parts = uniqueByText(spans).map(s => s.exact_text);
  const hasHeading = parts.some(p => p.match(new RegExp(`^${ruleNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)));
  const heading = title ? `${ruleNumber}. ${title}` : ruleNumber;
  return cleanText([
    hasHeading ? null : heading,
    ...parts,
  ].filter(Boolean).join('\n'));
}

function groupTextLength(group) {
  const spans = uniqueByText(group.spans);
  const title = group.sourceTitle || chooseTitle(group.rules, group.ruleNumber);
  return assembleFullText(group.ruleNumber, title, spans.length ? spans : group.rules.map(r => ({ exact_text: r.body }))).length;
}

function collapseDuplicateRuleGroups(groups) {
  const best = new Map();
  for (const group of groups) {
    const existing = best.get(group.ruleNumber);
    if (!existing || groupTextLength(group) > groupTextLength(existing)) {
      best.set(group.ruleNumber, group);
    }
  }
  return [...best.values()].sort((a, b) => {
    const ap = Math.min(...a.spans.map(s => s.page_start).filter(Number.isInteger));
    const bp = Math.min(...b.spans.map(s => s.page_start).filter(Number.isInteger));
    if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return ap - bp;
    return a.ruleNumber.localeCompare(b.ruleNumber, undefined, { numeric: true });
  });
}

const TOKEN_STOP_WORDS = new Set([
  'the','and','for','with','from','that','this','rule','rules','league',
  'uniform','uniforms','equipment','requirements','requirement',
]);

function titleTokens(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !TOKEN_STOP_WORDS.has(t));
}

function overlapCount(aTokens, text) {
  const haystack = ` ${cleanText(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  return aTokens.filter(t => haystack.includes(` ${t} `) || haystack.includes(` ${t}s `)).length;
}

async function ensureSchema(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS rule_units (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      league_id           uuid NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      league_slug         text NOT NULL,
      rulebook_version_id uuid NOT NULL REFERENCES rulebook_versions(id) ON DELETE CASCADE,
      rule_number         text NOT NULL,
      title               text,
      parent_rule_number  text,
      full_text           text NOT NULL,
      page_start          integer,
      page_end            integer,
      source_ids          uuid[] NOT NULL DEFAULT '{}',
      atom_ids            uuid[] NOT NULL DEFAULT '{}',
      section_path        text,
      search_text         text GENERATED ALWAYS AS (
        coalesce(rule_number, '') || ' ' ||
        coalesce(title, '') || ' ' ||
        coalesce(full_text, '') || ' ' ||
        coalesce(section_path, '')
      ) STORED,
      search_vector       tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(rule_number, '') || ' ' ||
          coalesce(title, '') || ' ' ||
          coalesce(full_text, '') || ' ' ||
          coalesce(section_path, '')
        )
      ) STORED,
      embedding           vector(1536),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (rulebook_version_id, rule_number)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS rule_units_version_rule_idx
      ON rule_units(rulebook_version_id, rule_number)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS rule_units_search_vector_idx
      ON rule_units USING gin(search_vector)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS rule_units_embedding_idx
      ON rule_units USING hnsw (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL
  `).catch(async err => {
    console.warn(`[rule-units] HNSW index skipped: ${err.message}`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS rule_units_embedding_ivfflat_idx
        ON rule_units USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 32)
        WHERE embedding IS NOT NULL
    `).catch(err2 => console.warn(`[rule-units] IVFFLAT index skipped: ${err2.message}`));
  });
}

async function fetchActiveBamsbl(client) {
  const { rows } = await client.query(`
    SELECT l.id AS league_id, l.slug, rv.id AS version_id
    FROM leagues l
    JOIN rulebook_versions rv ON rv.league_id = l.id
    WHERE l.slug = 'bamsbl' AND rv.status = 'active'
  `);
  if (rows.length === 0) {
    throw new Error('No active BAMSBL rulebook_version found.');
  }
  return rows[0];
}

function headingFromSpan(text) {
  const cleaned = cleanText(text);
  // BAMSBL rules use three-digit section numbers. Do not treat sub-items like
  // "3. REMOVED HITTER" as top-level rule units.
  const match = cleaned.match(/^(\d{3})(?:\.|\b)\s*(.*)$/);
  if (!match) return null;
  const ruleNumber = normalizeRuleNumber(match[1]);
  if (!ruleNumber) return null;
  const title = cleanText(match[2]).replace(/\s*\(revised\s+\d{4}\)\s*$/i, '').trim() || null;
  return { ruleNumber, title };
}

async function fetchOrderedSourceGroups(client, versionId) {
  const { rows } = await client.query(`
    SELECT
      rs.id AS source_id,
      rs.exact_text,
      rs.page_start,
      rs.page_end,
      rs.section_path,
      rs.char_start,
      rs.char_end
    FROM rule_sources rs
    JOIN rule_documents rd ON rd.id = rs.document_id
    WHERE rd.version_id = $1
    ORDER BY rs.page_start NULLS LAST, rs.char_start NULLS LAST, rs.char_end NULLS LAST, rs.id
  `, [versionId]);

  const groups = [];
  let current = null;

  for (const row of rows) {
    const heading = headingFromSpan(row.exact_text);
    if (heading) {
      current = {
        ruleNumber: heading.ruleNumber,
        sourceTitle: heading.title,
        rules: [],
        spans: [],
      };
      groups.push(current);
    }

    if (!current) continue;
    current.spans.push({
      id: row.source_id,
      exact_text: row.exact_text,
      page_start: row.page_start,
      page_end: row.page_end,
      section_path: row.section_path,
      char_start: row.char_start,
      char_end: row.char_end,
    });
  }

  // Add atom metadata to source-derived groups. Source order is authoritative
  // for full_text; atom metadata is advisory for title and diagnostics.
  const { rows: atoms } = await client.query(`
    SELECT id, rule_number, title, body
    FROM rules
    WHERE rulebook_version_id = $1
      AND nullif(trim(rule_number), '') IS NOT NULL
      AND trim(rule_number) <> '-'
  `, [versionId]);
  const byRule = new Map();
  for (const atom of atoms) {
    const rn = normalizeRuleNumber(atom.rule_number);
    if (!rn) continue;
    if (!byRule.has(rn)) byRule.set(rn, []);
    byRule.get(rn).push(atom);
  }
  for (const group of groups) {
    group.rules = byRule.get(group.ruleNumber) ?? [];
  }

  return groups;
}

async function fetchLinkDerivedRuleGroups(client, versionId) {
  const { rows } = await client.query(`
    SELECT
      r.id AS atom_id,
      r.rule_number,
      r.title,
      r.body,
      rs.id AS source_id,
      rs.exact_text,
      rs.page_start,
      rs.page_end,
      rs.section_path,
      rs.char_start,
      rs.char_end
    FROM rules r
    LEFT JOIN rule_source_links rsl ON rsl.rule_id = r.id
    LEFT JOIN rule_sources rs ON rs.id = rsl.source_id
    WHERE r.rulebook_version_id = $1
      AND nullif(trim(r.rule_number), '') IS NOT NULL
      AND trim(r.rule_number) <> '-'
    ORDER BY
      r.rule_number,
      rs.page_start NULLS LAST,
      rs.char_start NULLS LAST,
      rs.char_end NULLS LAST,
      r.created_at,
      r.id
  `, [versionId]);

  const groups = new Map();
  for (const row of rows) {
    const ruleNumber = normalizeRuleNumber(row.rule_number);
    if (!ruleNumber) continue;
    if (!groups.has(ruleNumber)) {
      groups.set(ruleNumber, { ruleNumber, rules: [], spans: [] });
    }
    const group = groups.get(ruleNumber);
    group.rules.push({
      id: row.atom_id,
      title: row.title,
      body: row.body,
    });
    if (row.source_id && row.exact_text) {
      group.spans.push({
        id: row.source_id,
        exact_text: row.exact_text,
        page_start: row.page_start,
        page_end: row.page_end,
        section_path: row.section_path,
        char_start: row.char_start,
        char_end: row.char_end,
      });
    }
  }

  // Some body spans were parsed correctly but never linked to their numbered
  // atoms. If an unlinked span is immediately contiguous with the last linked
  // span for a rule, absorb it into that unit. This deliberately uses a tiny
  // char gap threshold so Rule 305's final sentence is recovered without
  // swallowing the whole Equipment section.
  const { rows: allSources } = await client.query(`
    SELECT rs.id, rs.exact_text, rs.page_start, rs.page_end, rs.section_path,
           rs.char_start, rs.char_end,
           count(r.id) FILTER (
             WHERE nullif(trim(r.rule_number), '') IS NOT NULL
               AND trim(r.rule_number) <> '-'
           )::int AS numbered_link_count
    FROM rule_sources rs
    JOIN rule_documents rd ON rd.id = rs.document_id
    LEFT JOIN rule_source_links rsl ON rsl.source_id = rs.id
    LEFT JOIN rules r ON r.id = rsl.rule_id AND r.rulebook_version_id = rd.version_id
    WHERE rd.version_id = $1
    GROUP BY rs.id, rs.exact_text, rs.page_start, rs.page_end, rs.section_path, rs.char_start, rs.char_end
    ORDER BY rs.page_start NULLS LAST, rs.char_start NULLS LAST, rs.char_end NULLS LAST, rs.id
  `, [versionId]);

  const sourceById = new Map(allSources.map(s => [s.id, s]));
  const ordered = allSources;
  for (const group of groups.values()) {
    const linked = uniqueByText(group.spans)
      .filter(s => Number.isInteger(s.char_end))
      .sort((a, b) => a.char_end - b.char_end);
    if (linked.length === 0) continue;
    let last = linked[linked.length - 1];

    while (true) {
      const idx = ordered.findIndex(s => s.id === last.id);
      const next = idx >= 0 ? ordered[idx + 1] : null;
      if (!next || next.numbered_link_count > 0) break;
      if (!Number.isInteger(next.char_start) || !Number.isInteger(last.char_end)) break;
      const gap = next.char_start - last.char_end;
      if (gap < 0 || gap > 10) break;
      const source = sourceById.get(next.id);
      group.spans.push({
        id: source.id,
        exact_text: source.exact_text,
        page_start: source.page_start,
        page_end: source.page_end,
        section_path: source.section_path,
        char_start: source.char_start,
        char_end: source.char_end,
      });
      last = source;
    }
  }

  // Repair narrow heading-only rules whose body was extracted as an unnumbered
  // atom. Keep this deterministic; generic orphan matching produced false
  // positives for pitcher-related playoff eligibility text.
  const orphanBodyHintsByRule = new Map([
    ['330', ['Pitchers cannot wear white or gray']],
    ['401', [
      'The Home team on the official schedule shall occupy',
      'The Visiting team shall occupy',
    ]],
  ]);

  const { rows: orphanAtoms } = await client.query(`
    SELECT r.id AS atom_id, r.title, r.body,
           rs.id AS source_id, rs.exact_text, rs.page_start, rs.page_end,
           rs.section_path, rs.char_start, rs.char_end
    FROM rules r
    LEFT JOIN rule_source_links rsl ON rsl.rule_id = r.id
    LEFT JOIN rule_sources rs ON rs.id = rsl.source_id
    WHERE r.rulebook_version_id = $1
      AND (nullif(trim(r.rule_number), '') IS NULL OR trim(r.rule_number) = '-')
      AND nullif(trim(r.body), '') IS NOT NULL
  `, [versionId]);

  for (const group of groups.values()) {
    const spans = uniqueByText(group.spans);
    if (spans.length !== 1) continue;
    const hints = orphanBodyHintsByRule.get(group.ruleNumber);
    if (!hints) continue;

    for (const hint of hints) {
      const best = orphanAtoms.find(atom =>
        cleanText(atom.body).startsWith(hint) ||
        cleanText(atom.exact_text).startsWith(hint)
      );
      if (!best) continue;

      group.rules.push({
        id: best.atom_id,
        title: best.title,
        body: best.body,
      });
      if (best.source_id && best.exact_text) {
        group.spans.push({
          id: best.source_id,
          exact_text: best.exact_text,
          page_start: best.page_start,
          page_end: best.page_end,
          section_path: best.section_path,
          char_start: best.char_start,
          char_end: best.char_end,
        });
      }
    }
  }

  return [...groups.values()];
}

async function upsertRuleUnit(client, active, group) {
  const spans = uniqueByText(group.spans);
  const title = group.sourceTitle || chooseTitle(group.rules, group.ruleNumber);
  const fullText = assembleFullText(group.ruleNumber, title, spans.length ? spans : group.rules.map(r => ({ exact_text: r.body })));
  if (!fullText) return false;

  const sourceIds = [...new Set(spans.map(s => s.id).filter(Boolean))];
  const atomIds = [...new Set(group.rules.map(r => r.id).filter(Boolean))];
  const pages = spans.flatMap(s => [s.page_start, s.page_end]).filter(n => Number.isInteger(n));
  const pageStart = pages.length ? Math.min(...pages) : null;
  const pageEnd = pages.length ? Math.max(...pages) : null;
  const sectionPath = spans.map(s => s.section_path).find(Boolean) ?? null;

  await client.query(`
    INSERT INTO rule_units (
      league_id, league_slug, rulebook_version_id,
      rule_number, title, parent_rule_number, full_text,
      page_start, page_end, source_ids, atom_ids, section_path,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
    ON CONFLICT (rulebook_version_id, rule_number)
    DO UPDATE SET
      title = EXCLUDED.title,
      parent_rule_number = EXCLUDED.parent_rule_number,
      full_text = EXCLUDED.full_text,
      page_start = EXCLUDED.page_start,
      page_end = EXCLUDED.page_end,
      source_ids = EXCLUDED.source_ids,
      atom_ids = EXCLUDED.atom_ids,
      section_path = EXCLUDED.section_path,
      embedding = CASE
        WHEN rule_units.full_text IS DISTINCT FROM EXCLUDED.full_text
          OR rule_units.title IS DISTINCT FROM EXCLUDED.title
        THEN NULL
        ELSE rule_units.embedding
      END,
      updated_at = now()
  `, [
    active.league_id,
    active.slug,
    active.version_id,
    group.ruleNumber,
    title,
    null,
    fullText,
    pageStart,
    pageEnd,
    sourceIds,
    atomIds,
    sectionPath,
  ]);

  return true;
}

async function main() {
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const active = await fetchActiveBamsbl(client);
    const rawSourceGroups = await fetchOrderedSourceGroups(client, active.version_id);
    const sourceGroups = collapseDuplicateRuleGroups(rawSourceGroups);
    const linkGroups = await fetchLinkDerivedRuleGroups(client, active.version_id);
    const groups = collapseDuplicateRuleGroups([...sourceGroups, ...linkGroups]);
    let written = 0;

    for (const group of groups) {
      if (await upsertRuleUnit(client, active, group)) written += 1;
    }

    const { rows: [summary] } = await client.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
        count(*) FILTER (WHERE rule_number IN ('305','330'))::int AS uniform_rules
      FROM rule_units
      WHERE league_slug = 'bamsbl' AND rulebook_version_id = $1
    `, [active.version_id]);

    console.log(`[rule-units] active_version=${active.version_id}`);
    console.log(`[rule-units] source_order_groups_raw=${rawSourceGroups.length}`);
    console.log(`[rule-units] source_order_groups_deduped=${sourceGroups.length}`);
    console.log(`[rule-units] link_anchor_groups=${linkGroups.length}`);
    console.log(`[rule-units] total_groups=${groups.length}`);
    console.log(`[rule-units] upserted=${written}`);
    console.log(`[rule-units] total=${summary.total} embedded=${summary.embedded} uniform_rules=${summary.uniform_rules}`);

    const { rows: samples } = await client.query(`
      SELECT rule_number, title, page_start, full_text
      FROM rule_units
      WHERE league_slug='bamsbl'
        AND rulebook_version_id=$1
        AND rule_number IN ('305','330')
      ORDER BY rule_number
    `, [active.version_id]);
    for (const s of samples) {
      console.log(`\n[rule-units] sample Rule ${s.rule_number} (${s.title ?? 'untitled'}) p.${s.page_start ?? '?'}`);
      console.log(s.full_text);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[rule-units] migration failed:', err);
  process.exit(1);
});
