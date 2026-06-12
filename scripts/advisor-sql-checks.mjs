/**
 * scripts/advisor-sql-checks.mjs
 *
 * Runs the 5 SQL validation queries for Path A (active-version) verification
 * and prints results to the console.
 *
 * Usage:
 *   node scripts/advisor-sql-checks.mjs
 *   node scripts/advisor-sql-checks.mjs bamsbl   (override league slug)
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* rely on process env */ }

const { Pool } = pg;
const pool  = new Pool({ connectionString: process.env.DATABASE_URL });
const slug  = process.argv[2] ?? 'bamsbl';
const HR    = '─'.repeat(62);

console.log(`\n━━━  Advisor SQL Checks — league: ${slug}  ━━━\n`);

const client = await pool.connect();

try {
  // ── Query 1: Version statuses for the league ───────────────────────────────
  console.log(`${HR}`);
  console.log('Query 1: rulebook_version statuses for this league');
  console.log('  Expect: exactly one row with status = "active"');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT rv.id, rv.season, rv.status, rv.created_at, rv.updated_at
      FROM   rulebook_versions rv
      JOIN   leagues l ON l.id = rv.league_id
      WHERE  l.slug = $1
      ORDER  BY rv.created_at DESC
    `, [slug]);

    if (r.rows.length === 0) {
      console.log('  (no rows)\n');
    } else {
      for (const row of r.rows) {
        const active = row.status === 'active' ? ' ✓ ACTIVE' : '';
        console.log(`  ${row.id}  season=${row.season ?? 'n/a'}  status=${row.status}${active}`);
        console.log(`    created=${row.created_at.toISOString().slice(0, 19)}  updated=${row.updated_at.toISOString().slice(0, 19)}`);
      }
      const activeCount = r.rows.filter(r => r.status === 'active').length;
      console.log(`\n  → ${r.rows.length} version(s) total, ${activeCount} active`);
      console.log();
    }
  }

  // ── Query 2: Rule count for the active version ─────────────────────────────
  console.log(`${HR}`);
  console.log('Query 2: rule count for the active version');
  console.log('  Expect: > 0 rules with a non-null rulebook_version_id');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT rv.id AS version_id, rv.season, rv.status,
             COUNT(ru.id) AS rule_count
      FROM   rulebook_versions rv
      JOIN   leagues l  ON l.id  = rv.league_id
      LEFT JOIN rules ru ON ru.rulebook_version_id = rv.id
      WHERE  l.slug = $1 AND rv.status = 'active'
      GROUP BY rv.id, rv.season, rv.status
    `, [slug]);

    if (r.rows.length === 0) {
      console.log('  (no active version found)\n');
    } else {
      const row = r.rows[0];
      console.log(`  version_id  : ${row.version_id}`);
      console.log(`  season      : ${row.season ?? 'n/a'}`);
      console.log(`  rule_count  : ${row.rule_count}`);
      console.log(`\n  → ${row.rule_count > 0 ? '✓ pass' : '✗ FAIL — no rules'}\n`);
    }
  }

  // ── Query 3: Unlinked rules (rules with no source links) ───────────────────
  console.log(`${HR}`);
  console.log('Query 3: rules with no rule_source_links entry (unlinked)');
  console.log('  Expect: 0 unlinked rules');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT COUNT(*) AS unlinked
      FROM   rules ru
      JOIN   rulebook_versions rv ON rv.id = ru.rulebook_version_id
      JOIN   leagues l            ON l.id  = rv.league_id
      WHERE  l.slug = $1
        AND  rv.status = 'active'
        AND  NOT EXISTS (
          SELECT 1 FROM rule_source_links rsl WHERE rsl.rule_id = ru.id
        )
    `, [slug]);

    const n = Number(r.rows[0]?.unlinked ?? -1);
    console.log(`  unlinked rules : ${n}`);
    console.log(`\n  → ${n === 0 ? '✓ pass' : `✗ FAIL — ${n} rules have no source links`}\n`);
  }

  // ── Query 4: Linked source span count ──────────────────────────────────────
  console.log(`${HR}`);
  console.log('Query 4: distinct source spans linked to rules in the active version');
  console.log('  Expect: > 0 linked spans; all spans under the same version');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT
        COUNT(DISTINCT rsl.source_id)   AS linked_spans,
        COUNT(DISTINCT rd.version_id)   AS distinct_versions_in_sources
      FROM   rule_source_links rsl
      JOIN   rules ru            ON ru.id  = rsl.rule_id
      JOIN   rulebook_versions rv ON rv.id = ru.rulebook_version_id
      JOIN   leagues l           ON l.id   = rv.league_id
      JOIN   rule_sources rs     ON rs.id  = rsl.source_id
      JOIN   rule_documents rd   ON rd.id  = rs.document_id
      WHERE  l.slug  = $1
        AND  rv.status = 'active'
    `, [slug]);

    const row = r.rows[0];
    const spans    = Number(row?.linked_spans ?? 0);
    const versions = Number(row?.distinct_versions_in_sources ?? 0);
    console.log(`  linked_spans                  : ${spans}`);
    console.log(`  distinct rule_document versions: ${versions}  (must be 1)`);
    const pass = spans > 0 && versions === 1;
    console.log(`\n  → ${pass ? '✓ pass' : `✗ FAIL — spans=${spans}, distinct_versions=${versions}`}\n`);
  }

  // ── Query 5: Legacy NULL-version rules for this league ─────────────────────
  console.log(`${HR}`);
  console.log('Query 5: legacy rules with rulebook_version_id IS NULL for this league');
  console.log('  Expect: present but left untouched (not 0 — these are pre-V3 rows)');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT COUNT(*) AS legacy_null_rules
      FROM   rules ru
      JOIN   leagues l ON l.id = ru.league_id
      WHERE  l.slug = $1
        AND  ru.rulebook_version_id IS NULL
    `, [slug]);

    const n = Number(r.rows[0]?.legacy_null_rules ?? 0);
    console.log(`  legacy NULL-version rules : ${n}`);
    console.log(`\n  → ${n >= 0 ? '✓ present (these are pre-V3 rows, not cleaned up yet)' : '(error)'}\n`);
  }

  // ── Query 6: Cross-version source links ────────────────────────────────────
  // Every source span linked to an active-version rule must belong to a
  // rule_document whose version_id equals the rule's rulebook_version_id.
  // A non-zero count here means a rule from one version is citing a span
  // ingested under a different version — data corruption.
  console.log(`${HR}`);
  console.log('Query 6: cross-version source link integrity');
  console.log('  Expect: 0 cross-version links');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT COUNT(*) AS cross_version_links
      FROM   rule_source_links rsl
      JOIN   rules             ru  ON ru.id  = rsl.rule_id
      JOIN   rule_sources      rs  ON rs.id  = rsl.source_id
      JOIN   rule_documents    rd  ON rd.id  = rs.document_id
      JOIN   rulebook_versions rv  ON rv.id  = ru.rulebook_version_id
      JOIN   leagues           l   ON l.id   = rv.league_id
      WHERE  l.slug              = $1
        AND  rv.status           = 'active'
        AND  ru.rulebook_version_id IS NOT NULL
        AND  rd.version_id      != ru.rulebook_version_id
    `, [slug]);

    const n = Number(r.rows[0]?.cross_version_links ?? -1);
    console.log(`  cross-version source links : ${n}`);
    console.log(`\n  → ${n === 0 ? '✓ pass' : `✗ FAIL — ${n} link(s) span multiple versions`}\n`);
  }

  // ── Query 7: Legacy NULL-version rules excluded from active-version FTS ────
  // Confirms that a representative FTS query over rule_sources returns ZERO
  // source spans belonging to a legacy (NULL rulebook_version_id) rule.
  // The ask-v2 retrieval already filters by rd.version_id = activeVersionId,
  // but this validates the data boundary at the DB level.
  console.log(`${HR}`);
  console.log('Query 7: legacy NULL-version rules absent from active-version source spans');
  console.log('  Expect: 0 legacy spans reachable via active-version join');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT COUNT(*) AS legacy_spans_in_active_path
      FROM   rule_source_links rsl
      JOIN   rules             ru  ON ru.id  = rsl.rule_id
      JOIN   rule_sources      rs  ON rs.id  = rsl.source_id
      JOIN   rule_documents    rd  ON rd.id  = rs.document_id
      JOIN   rulebook_versions rv  ON rv.id  = rd.version_id
      JOIN   leagues           l   ON l.id   = rv.league_id
      WHERE  l.slug              = $1
        AND  rv.status           = 'active'
        AND  ru.rulebook_version_id IS NULL
    `, [slug]);

    const n = Number(r.rows[0]?.legacy_spans_in_active_path ?? -1);
    console.log(`  legacy spans in active path : ${n}`);
    console.log(`\n  → ${n === 0 ? '✓ pass — legacy rules cannot be reached via active-version join' : `✗ FAIL — ${n} legacy span(s) reachable`}\n`);
  }

  // ── Bonus: sample of first 5 rules in active version ──────────────────────
  console.log(`${HR}`);
  console.log('Bonus: first 5 rules in the active version (sorted by rule_number)');
  console.log(`${HR}`);
  {
    const r = await client.query(`
      SELECT ru.rule_number, ru.title, length(ru.body) AS body_chars
      FROM   rules ru
      JOIN   rulebook_versions rv ON rv.id = ru.rulebook_version_id
      JOIN   leagues l            ON l.id  = rv.league_id
      WHERE  l.slug  = $1
        AND  rv.status = 'active'
      ORDER  BY ru.rule_number
      LIMIT  5
    `, [slug]);

    if (r.rows.length === 0) {
      console.log('  (no rules in active version)\n');
    } else {
      for (const row of r.rows) {
        console.log(`  [${row.rule_number}]  ${row.title}  (${row.body_chars} chars)`);
      }
      console.log();
    }
  }

  console.log(`━━━  Done  ━━━\n`);

} finally {
  client.release();
  await pool.end();
}
