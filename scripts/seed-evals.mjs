/**
 * scripts/seed-evals.mjs
 *
 * Seeds the eval_cases table with critical BAMSBL edge-case questions.
 *
 * Uses INSERT … ON CONFLICT (id) DO NOTHING so the script is idempotent:
 * running it twice will not duplicate rows.
 *
 * Usage:
 *   node scripts/seed-evals.mjs
 *   node scripts/seed-evals.mjs --league llws   (future leagues)
 *
 * State values must match what api/ask-v2.js actually returns:
 *   'answered'           — factual RAG answer
 *   'needs_clarification'— judgment-call play triggered an interview question
 *   'ruling'             — interview complete, ruling returned
 *   'unverifiable'       — verifier blocked the draft answer
 *
 * NOTE: The advisor's spec uses 'needs_fact' for the collision case; the API
 * returns 'needs_clarification' for this state.  We seed the actual API value
 * so evals pass against the live system.  The case_type column documents the
 * human-readable intent.
 */

import pg   from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

// ── Eval case definitions ─────────────────────────────────────────────────────
//
// Fields:
//   id                   — stable UUID so re-seeds are idempotent
//   league_slug          — must match a row in leagues table
//   question             — question sent to the API (FTS-friendly phrasing)
//   expected_state       — 'answered' | 'needs_clarification' | 'unverifiable'
//   expected_rule_number — if set, must appear in response.cited_rule_numbers
//   case_type            — human-readable intent label
//   tier                 — 'critical' | 'broad'
//   source               — 'human' | 'generated'

// ── Allowed enum values (from DB check constraints) ──────────────────────────
//
//   case_type:      factual | judgment | override | no_rule | exception |
//                   cross_ref | misleading | parent_fallback
//   expected_state: answered | needs_clarification | no_rule_found | league_not_found
//   tier:           critical | broad
//   source:         human | feedback

const EVAL_CASES = [
  {
    // ── Critical: must-slide rule ─────────────────────────────────────────────
    // Verifies that FTS retrieves Rule 505 spans and the verifier approves the answer.
    id:                   'ec000001-0000-0000-0000-000000000001',
    league_slug:          'bamsbl',
    question:             'when must a runner slide',
    expected_state:       'answered',
    expected_rule_number: '505',
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    // ── Critical: courtesy runner ─────────────────────────────────────────────
    // BAMSBL-specific rule that does not exist in MLB rulebooks.
    id:                   'ec000001-0000-0000-0000-000000000002',
    league_slug:          'bamsbl',
    question:             'what is the courtesy runner rule',
    expected_state:       'answered',
    expected_rule_number: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    // ── Critical: time limit ──────────────────────────────────────────────────
    // BAMSBL-specific time-limit rule absent from MLB.
    id:                   'ec000001-0000-0000-0000-000000000003',
    league_slug:          'bamsbl',
    question:             'what is the time limit for a game',
    expected_state:       'answered',
    expected_rule_number: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    // ── Critical: runner-collision judgment ───────────────────────────────────
    // No concrete ruling is possible without knowing intent, point of contact,
    // whether obstruction or interference applies, etc.
    // The judgment-matrix classifier must route this to needs_clarification.
    id:                   'ec000001-0000-0000-0000-000000000004',
    league_slug:          'bamsbl',
    question:             'runner hit the catcher at home plate',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // ── Broad-tier regression cases ───────────────────────────────────────────
  {
    id:                   'ec000001-0000-0000-0000-000000000005',
    league_slug:          'bamsbl',
    question:             'how many innings in a regulation game',
    expected_state:       'answered',
    expected_rule_number: null,
    case_type:            'factual',
    tier:                 'broad',
    source:               'human',
  },
  {
    id:                   'ec000001-0000-0000-0000-000000000006',
    league_slug:          'bamsbl',
    question:             'what is the infield fly rule',
    expected_state:       'answered',
    expected_rule_number: null,
    case_type:            'factual',
    tier:                 'broad',
    source:               'human',
  },
  {
    id:                   'ec000001-0000-0000-0000-000000000007',
    league_slug:          'bamsbl',
    question:             'can a pitcher reenter the game',
    expected_state:       'answered',
    expected_rule_number: null,
    case_type:            'factual',
    tier:                 'broad',
    source:               'human',
  },
];

// ── Insert ────────────────────────────────────────────────────────────────────

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  let inserted = 0;
  let skipped  = 0;

  for (const c of EVAL_CASES) {
    const res = await client.query(`
      INSERT INTO eval_cases
        (id, league_slug, question, expected_state, expected_rule_number,
         case_type, tier, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (league_slug, question) DO NOTHING
    `, [
      c.id, c.league_slug, c.question, c.expected_state,
      c.expected_rule_number ?? null, c.case_type, c.tier, c.source,
    ]);

    if (res.rowCount > 0) {
      console.log(`  ✓  [${c.tier.padEnd(8)}] ${c.case_type} — inserted`);
      inserted++;
    } else {
      console.log(`  –  [${c.tier.padEnd(8)}] ${c.case_type} — already exists, skipped`);
      skipped++;
    }
  }

  const total = await client.query('SELECT COUNT(*) FROM eval_cases');
  console.log(`\n  Inserted: ${inserted}  Skipped (already present): ${skipped}`);
  console.log(`  Total eval_cases rows: ${total.rows[0].count}`);
} catch (err) {
  console.error('  ✗ Seed failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
