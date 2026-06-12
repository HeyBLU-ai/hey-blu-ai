/**
 * scripts/verify-and-activate.mjs
 *
 * Advisor Step 4 + Step 5:
 *   1. Run 3 draft SQL integrity checks on the target version.
 *   2. If all pass (all return 0), activate via activate-version.mjs --yes.
 *   3. Run advisor-sql-checks.mjs to confirm active-version state.
 */

import pg             from 'pg';
import { execSync }   from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const VERSION_ID = 'f0623831-2dcd-4f2d-91a1-dbf770461e1b';
const HR         = '─'.repeat(64);

// ── Load .env.local ───────────────────────────────────────────────────────────
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

console.log(`\n━━━  Advisor Step 4: Draft SQL Checks  ━━━\n`);
console.log(`  Version: ${VERSION_ID}\n`);

// ── Check 1: Duplicate atom_keys ─────────────────────────────────────────────
const dup = await client.query(`
  SELECT atom_key, COUNT(*) AS cnt
  FROM   rules
  WHERE  rulebook_version_id = $1
  GROUP  BY atom_key
  HAVING COUNT(*) > 1
`, [VERSION_ID]);

const dupCount = dup.rows.length;
console.log(`${HR}`);
console.log(`Check 1 — Duplicate atom_keys`);
console.log(`  Result : ${dupCount} duplicate atom_key(s)   Expected: 0   ${dupCount === 0 ? '✓ PASS' : '✗ FAIL'}`);
if (dupCount > 0) {
  for (const r of dup.rows) console.log(`    atom_key="${r.atom_key}"  ×${r.cnt}`);
}

// ── Check 2: Rules without source links ──────────────────────────────────────
const unlinked = await client.query(`
  SELECT COUNT(*) AS n
  FROM   rules ru
  WHERE  ru.rulebook_version_id = $1
    AND  NOT EXISTS (
      SELECT 1 FROM rule_source_links rsl WHERE rsl.rule_id = ru.id
    )
`, [VERSION_ID]);

const unlinkedCount = Number(unlinked.rows[0].n);
console.log(`\nCheck 2 — Rules without source links`);
console.log(`  Result : ${unlinkedCount} unlinked rule(s)   Expected: 0   ${unlinkedCount === 0 ? '✓ PASS' : '✗ FAIL'}`);

// ── Check 3: Cross-version source links ──────────────────────────────────────
const crossVer = await client.query(`
  SELECT COUNT(*) AS n
  FROM   rules          ru
  JOIN   rule_source_links rsl ON rsl.rule_id  = ru.id
  JOIN   rule_sources      rs  ON rs.id        = rsl.source_id
  JOIN   rule_documents    rd  ON rd.id        = rs.document_id
  WHERE  ru.rulebook_version_id = $1
    AND  rd.version_id          <> $1
`, [VERSION_ID]);

const crossCount = Number(crossVer.rows[0].n);
console.log(`\nCheck 3 — Cross-version source links`);
console.log(`  Result : ${crossCount} cross-version link(s)   Expected: 0   ${crossCount === 0 ? '✓ PASS' : '✗ FAIL'}`);

client.release();
await pool.end();

// ── Gate ─────────────────────────────────────────────────────────────────────
const allPass = dupCount === 0 && unlinkedCount === 0 && crossCount === 0;
console.log(`\n${HR}`);
if (!allPass) {
  console.error('  ✗ One or more checks FAILED.  Aborting activation.');
  process.exit(1);
}
console.log('  ✓ All 3 checks passed.  Proceeding to activation.\n');

// ── Advisor Step 5: Activate ──────────────────────────────────────────────────
console.log(`━━━  Advisor Step 5: Activate  ━━━\n`);

try {
  const activateOut = execSync(
    `node scripts/activate-version.mjs --version-id ${VERSION_ID} --yes`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  console.log(activateOut);
} catch (err) {
  console.error('  ✗ Activation failed:');
  console.error(err.stdout || err.message);
  process.exit(1);
}

// ── Active-version advisor SQL checks ────────────────────────────────────────
console.log(`━━━  Active-Version Advisor Checks  ━━━\n`);

try {
  const checksOut = execSync(
    `node scripts/advisor-sql-checks.mjs bamsbl`,
    { encoding: 'utf8', stdio: 'pipe' },
  );
  console.log(checksOut);
} catch (err) {
  console.error('  ✗ Advisor SQL checks failed:');
  console.error(err.stdout || err.message);
  process.exit(1);
}
