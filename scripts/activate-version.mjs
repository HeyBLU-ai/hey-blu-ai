/**
 * scripts/activate-version.mjs
 *
 * Promotes a DRAFT rulebook_versions row to ACTIVE after running a battery
 * of pre-flight integrity checks.  Any previously ACTIVE version for the same
 * league is atomically RETIRED in the same transaction.
 *
 * Accuracy is the primary directive.  This script refuses to activate a version
 * that fails any integrity check.  Use --force only if you have manually audited
 * the data and understand the risk.
 *
 * Usage:
 *   node scripts/activate-version.mjs --version-id <uuid>           # dry run
 *   node scripts/activate-version.mjs --version-id <uuid> --yes     # activate
 *   node scripts/activate-version.mjs --version-id <uuid> --force   # skip draft check
 *   node scripts/activate-version.mjs --version-id <uuid> --yes --force
 *
 * Flags:
 *   --version-id <uuid>   Required. UUID of the rulebook_versions row to activate.
 *   --yes                 Execute the activation. Without this flag the script runs
 *                         as a dry run and prints the pre-flight report only.
 *   --force               Skip the "status must be draft" guard. Use with caution.
 *
 * Pre-flight checks (all must pass before --yes does anything):
 *   1. Version row exists.
 *   2. Status is 'draft' (waived by --force).
 *   3. At least one rules row has rulebook_version_id = <version-id>.
 *   4. No rules in this version are missing at least one rule_source_links row.
 *   5. No rule_source_links rows point to a rule_source whose rule_document has
 *      a different version_id (cross-version source contamination).
 *   6. No linked rule_sources have empty or whitespace-only exact_text.
 *
 * Activation (--yes):
 *   - RETIRE any currently ACTIVE version for the same league.
 *   - SET this version to ACTIVE.
 *   - Both updates run inside a single transaction.
 *   - Legacy rules (rulebook_version_id IS NULL) are NOT touched.
 *
 * npm script:
 *   "activate:rulebook": "node scripts/activate-version.mjs"
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ── .env.local loader ─────────────────────────────────────────────────────────

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

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const versionId = argValue('--version-id');
const withYes   = flag('--yes');
const withForce = flag('--force');

const HR = '─'.repeat(60);

if (!versionId) {
  console.error('\n  ✗  --version-id <uuid> is required.\n');
  console.error('  Usage: node scripts/activate-version.mjs --version-id <uuid> [--yes] [--force]\n');
  process.exit(1);
}

// Basic UUID format guard
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
  console.error(`\n  ✗  --version-id does not look like a UUID: "${versionId}"\n`);
  process.exit(1);
}

// ── DB connection ─────────────────────────────────────────────────────────────

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(label)   { console.log(`  ✓  ${label}`); }
function fail(label) { console.log(`  ✗  ${label}`); }
function warn(label) { console.log(`  ⚠  ${label}`); }
function info(label) { console.log(`     ${label}`); }

let exitCode = 0;

function check(passed, successMsg, failureMsg) {
  if (passed) {
    ok(successMsg);
  } else {
    fail(failureMsg);
    exitCode = 1;
  }
  return passed;
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n━━━  activate-version.mjs  ━━━\n`);
console.log(`  Version ID : ${versionId}`);
console.log(`  Mode       : ${withYes ? 'ACTIVATE (--yes)' : 'DRY RUN (add --yes to activate)'}`);
if (withForce) console.log(`  Force      : yes (draft status check bypassed)`);
console.log();

const client = await pool.connect();

try {
  // ── 1. Look up the version row ─────────────────────────────────────────────

  console.log(`${HR}\nPre-flight checks\n${HR}`);

  const versionRes = await client.query(`
    SELECT rv.id, rv.status, rv.season, rv.league_id, rv.source_hash, rv.created_at,
           l.slug   AS league_slug,
           l.name   AS league_name
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE rv.id = $1
  `, [versionId]);

  if (versionRes.rows.length === 0) {
    fail(`Version "${versionId}" not found in rulebook_versions.`);
    process.exit(1);
  }

  const version = versionRes.rows[0];
  ok(`Version found — ${version.league_slug} / season ${version.season ?? 'n/a'} / status "${version.status}"`);

  // ── 2. Status check ────────────────────────────────────────────────────────

  if (version.status === 'active') {
    fail('Version is already ACTIVE. Nothing to do.');
    process.exit(1);
  }
  if (version.status === 'retired') {
    if (!withForce) {
      fail('Version is RETIRED. Use --force to override (not recommended).');
      process.exit(1);
    }
    warn('Version is RETIRED — proceeding because --force is set.');
  }
  if (version.status === 'draft') {
    ok(`Status is 'draft' — safe to activate.`);
  } else if (version.status !== 'retired') {
    if (!withForce) {
      fail(`Status is "${version.status}" (expected "draft"). Use --force to override.`);
      process.exit(1);
    }
    warn(`Status is "${version.status}" — proceeding because --force is set.`);
  }

  // ── 3. At least one rule attached ─────────────────────────────────────────

  const ruleCountRes = await client.query(`
    SELECT COUNT(*) AS n FROM rules WHERE rulebook_version_id = $1
  `, [versionId]);
  const ruleCount = Number(ruleCountRes.rows[0].n);
  check(ruleCount > 0,
    `${ruleCount} rule(s) attached to this version.`,
    `No rules are attached to this version (rulebook_version_id = '${versionId}'). Run the ingest first.`,
  );

  // ── 4. No rules missing source links ──────────────────────────────────────

  const unlinkedRes = await client.query(`
    SELECT COUNT(*) AS n
    FROM rules r
    WHERE r.rulebook_version_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM rule_source_links rsl WHERE rsl.rule_id = r.id
      )
  `, [versionId]);
  const unlinkedCount = Number(unlinkedRes.rows[0].n);
  check(unlinkedCount === 0,
    `All rules have at least one source link.`,
    `${unlinkedCount} rule(s) in this version have no rule_source_links rows.`,
  );

  // ── 5. No cross-version source contamination ───────────────────────────────
  // Every rule_source_links.source_id should point to a rule_sources row whose
  // document_id → rule_documents.version_id equals our target version.

  const crossVersionRes = await client.query(`
    SELECT COUNT(*) AS n
    FROM rule_source_links rsl
    JOIN rules r            ON r.id  = rsl.rule_id
    JOIN rule_sources rs    ON rs.id = rsl.source_id
    JOIN rule_documents rd  ON rd.id = rs.document_id
    WHERE r.rulebook_version_id = $1
      AND rd.version_id <> $1
  `, [versionId]);
  const crossVersionCount = Number(crossVersionRes.rows[0].n);
  check(crossVersionCount === 0,
    `All linked sources belong to rule_documents in this version.`,
    `${crossVersionCount} source link(s) point to rule_sources from a DIFFERENT version. Data integrity risk.`,
  );

  // ── 6. No linked sources with empty exact_text ────────────────────────────

  const emptyTextRes = await client.query(`
    SELECT COUNT(*) AS n
    FROM rule_source_links rsl
    JOIN rules r         ON r.id  = rsl.rule_id
    JOIN rule_sources rs ON rs.id = rsl.source_id
    WHERE r.rulebook_version_id = $1
      AND char_length(trim(rs.exact_text)) = 0
  `, [versionId]);
  const emptyTextCount = Number(emptyTextRes.rows[0].n);
  check(emptyTextCount === 0,
    `All linked rule_sources have non-empty exact_text.`,
    `${emptyTextCount} linked rule_source(s) have empty or whitespace-only exact_text.`,
  );

  // ── Gather summary stats ──────────────────────────────────────────────────

  // Total linked source spans for this version's rules
  const linkedSpanRes = await client.query(`
    SELECT COUNT(DISTINCT rsl.source_id) AS n
    FROM rule_source_links rsl
    JOIN rules r ON r.id = rsl.rule_id
    WHERE r.rulebook_version_id = $1
  `, [versionId]);
  const linkedSpanCount = Number(linkedSpanRes.rows[0].n);

  // Current active version for this league (if any)
  const activeRes = await client.query(`
    SELECT id, season, created_at
    FROM rulebook_versions
    WHERE league_id = $1 AND status = 'active'
  `, [version.league_id]);
  const currentActive = activeRes.rows[0] ?? null;

  // Legacy NULL-version rules for this league
  const legacyRes = await client.query(`
    SELECT COUNT(*) AS n FROM rules
    WHERE league_id = $1 AND rulebook_version_id IS NULL
  `, [version.league_id]);
  const legacyCount = Number(legacyRes.rows[0].n);

  // ── Dry-run report ─────────────────────────────────────────────────────────

  console.log(`\n${HR}\nSummary\n${HR}`);
  console.log(`  Target league       : ${version.league_name} (${version.league_slug})`);
  console.log(`  Target version      : ${versionId.slice(0, 8)}…  (season ${version.season ?? 'n/a'}, "${version.status}")`);
  console.log(`  Current active      : ${currentActive
    ? `${currentActive.id.slice(0, 8)}…  (season ${currentActive.season ?? 'n/a'}, created ${currentActive.created_at.toISOString().slice(0, 10)})`
    : 'none'}`);
  console.log(`  Rules               : ${ruleCount}`);
  console.log(`  Linked source spans : ${linkedSpanCount}`);
  console.log(`  Unlinked rules      : ${unlinkedCount}`);
  console.log(`  Cross-version links : ${crossVersionCount}`);
  console.log(`  Empty-text sources  : ${emptyTextCount}`);
  console.log(`  Legacy NULL rules   : ${legacyCount}  (not touched by activation)`);

  // Abort if any check failed
  if (exitCode !== 0) {
    console.log(`\n${HR}`);
    fail('One or more pre-flight checks failed. Fix the issues above before activating.');
    console.log(`${HR}\n`);
    process.exit(1);
  }

  // ── No --yes: stop here ────────────────────────────────────────────────────

  if (!withYes) {
    console.log(`\n${HR}`);
    info('All pre-flight checks passed.  No changes made.');
    info('Run with --yes to execute the activation.');
    console.log(`${HR}\n`);
    process.exit(0);
  }

  // ── Activation (--yes) ────────────────────────────────────────────────────

  console.log(`\n${HR}\nActivation\n${HR}`);

  await client.query('BEGIN');
  try {
    // Step A: Retire any currently ACTIVE version for this league
    const retireRes = await client.query(`
      UPDATE rulebook_versions
         SET status = 'retired', updated_at = now()
       WHERE league_id = $1
         AND status = 'active'
      RETURNING id, season
    `, [version.league_id]);

    if (retireRes.rowCount === 0) {
      ok('No existing active version to retire.');
    } else {
      for (const retired of retireRes.rows) {
        ok(`Retired version ${retired.id.slice(0, 8)}… (season ${retired.season ?? 'n/a'})`);
      }
    }

    // Step B: Activate target version
    const activateRes = await client.query(`
      UPDATE rulebook_versions
         SET status = 'active', updated_at = now()
       WHERE id = $1
      RETURNING id, status
    `, [versionId]);

    if (activateRes.rowCount === 0) {
      throw new Error('Activation UPDATE matched 0 rows — version ID may have changed.');
    }

    await client.query('COMMIT');
    ok(`Version ${versionId.slice(0, 8)}… is now ACTIVE.`);

  } catch (err) {
    await client.query('ROLLBACK');
    fail(`Transaction ROLLED BACK: ${err.message}`);
    process.exit(1);
  }

  // ── Post-activation verification queries ─────────────────────────────────

  console.log(`\n${HR}\nVerification queries\n${HR}`);
  console.log('  Run these in your SQL client to confirm:\n');

  const lid = version.league_id;
  const vid = versionId;

  const queries = [
    {
      label: 'Version statuses for this league (expect exactly one "active"):',
      sql:
        `SELECT id, season, status, updated_at\n` +
        `FROM rulebook_versions\n` +
        `WHERE league_id = '${lid}'\n` +
        `ORDER BY created_at DESC;`,
    },
    {
      label: 'Rule count for this version:',
      sql:
        `SELECT COUNT(*) AS rule_count\n` +
        `FROM rules\n` +
        `WHERE rulebook_version_id = '${vid}';`,
    },
    {
      label: 'Unlinked rules (expect 0):',
      sql:
        `SELECT COUNT(*) AS unlinked\n` +
        `FROM rules r\n` +
        `WHERE r.rulebook_version_id = '${vid}'\n` +
        `  AND NOT EXISTS (\n` +
        `    SELECT 1 FROM rule_source_links rsl WHERE rsl.rule_id = r.id\n` +
        `  );`,
    },
    {
      label: 'Linked source spans:',
      sql:
        `SELECT COUNT(DISTINCT rsl.source_id) AS linked_spans\n` +
        `FROM rule_source_links rsl\n` +
        `JOIN rules r ON r.id = rsl.rule_id\n` +
        `WHERE r.rulebook_version_id = '${vid}';`,
    },
    {
      label: `Legacy NULL-version rules for this league (not activated, left untouched):`,
      sql:
        `SELECT COUNT(*) AS legacy_null_rules\n` +
        `FROM rules\n` +
        `WHERE league_id = '${lid}'\n` +
        `  AND rulebook_version_id IS NULL;`,
    },
  ];

  for (const q of queries) {
    console.log(`  -- ${q.label}`);
    for (const line of q.sql.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log();
  }

  console.log(`${HR}`);
  ok('Activation complete.');
  console.log(`${HR}\n`);

} finally {
  client.release();
  await pool.end();
}

process.exit(exitCode);
