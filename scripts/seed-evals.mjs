/**
 * scripts/seed-evals.mjs
 *
 * Seeds the eval_cases table with 50 critical BAMSBL eval cases.
 *
 * CASE MIX (50 critical):
 *   10  factual rule lookups          — expected_state: 'answered'
 *   10  judgment / must clarify       — expected_state: 'needs_clarification'
 *   10  judgment / enough facts       — expected_state: 'answered'
 *    8  local override / local-specific — expected_state: 'answered'
 *    5  no-rule-found / out-of-scope  — expected_state: 'answered'
 *    4  misleading phrasing           — expected_state: 'answered'
 *    3  parent-fallback               — expected_state: 'answered'
 *
 * ROUTING NOTES:
 *   "judgment / must clarify" cases are phrased to contain Tier-1 prescreen
 *   trigger keywords (deterministic — no LLM classifier dependency).
 *   "judgment / enough facts" cases start with DEFINITIONAL_PREFIXES
 *   ('what is', 'what happens', 'what are') so prescreenForMatrix returns null
 *   immediately and they go straight to RAG → 'answered'.
 *
 * IDEMPOTENT:
 *   Uses ON CONFLICT (league_slug, question) DO NOTHING, so repeated runs are safe.
 *   Existing rows are left untouched.
 *
 * UUID SCHEME:
 *   ec000001-...-000X  existing cases  (001–004 critical, 005–007 broad)
 *   ec000002-...-000X  new cases added by this revision (001–046)
 *
 * Usage:
 *   node scripts/seed-evals.mjs
 *
 * State enum (matches api/ask-v2.js):
 *   'answered' | 'needs_clarification' | 'ruling' | 'unverifiable'
 *
 * case_type enum (eval_cases DB constraint):
 *   'factual' | 'judgment' | 'override' | 'no_rule' | 'exception' |
 *   'cross_ref' | 'misleading' | 'parent_fallback'
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

const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

// ── Schema migration: add expected_source_text if missing ─────────────────────
try {
  await client.query(`
    ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS expected_source_text TEXT
  `);
  console.log('  ✓ eval_cases.expected_source_text column present');
} catch (err) {
  console.error('  ✗ Schema migration failed:', err.message);
  client.release();
  await pool.end();
  process.exit(1);
}

// ── Eval case definitions ─────────────────────────────────────────────────────
//
// Fields:
//   id                   — stable UUID (idempotency key via conflict on question+league)
//   league_slug          — must match a row in leagues table
//   question             — question sent to the API (affects routing; see notes above)
//   expected_state       — API response.state that must match
//   expected_rule_number — if set, must appear (prefix/exact) in response.cited_rule_numbers
//   expected_source_text — if set, must appear as substring in any retrieved source span body
//   case_type            — human-readable intent category
//   tier                 — 'critical' | 'broad'
//   source               — 'human' | 'feedback'

const EVAL_CASES = [

  // ═══════════════════════════════════════════════════════════════════════════
  // EXISTING CASES (001–004) — re-declared here for documentation.
  // These will be skipped (DO NOTHING) if already present.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Factual: must-slide ───────────────────────────────────────────────────
  // Must-slide / no-collision rules are unnumbered in the active BAMSBL
  // rulebook; expected_rule_number is null — we only check state + verifier.
  {
    id:                   'ec000001-0000-0000-0000-000000000001',
    league_slug:          'bamsbl',
    question:             'when must a runner slide',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },

  // ── Factual: courtesy runner ───────────────────────────────────────────────
  // BAMSBL-specific rule absent from MLB. Verifies local-only rules are served.
  {
    id:                   'ec000001-0000-0000-0000-000000000002',
    league_slug:          'bamsbl',
    question:             'what is the courtesy runner rule',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },

  // ── Factual: game time limit ────────────────────────────────────────────────
  // BAMSBL-specific time-limit rule absent from MLB.
  {
    id:                   'ec000001-0000-0000-0000-000000000003',
    league_slug:          'bamsbl',
    question:             'what is the time limit for a game',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },

  // ── Judgment / must clarify: runner–catcher collision ─────────────────────
  // Routed by LLM classifier (Tier 2) — "runner hit catcher" lacks Tier-1 keywords.
  // Verifies the classifier correctly identifies a collision scenario.
  {
    id:                   'ec000001-0000-0000-0000-000000000004',
    league_slug:          'bamsbl',
    question:             'runner hit the catcher at home plate',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW CASES (ec000002-...) — 46 cases completing the 50-case critical suite.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── FACTUAL (7 new → 10 total with the 3 existing above) ──────────────────

  {
    id:                   'ec000002-0000-0000-0000-000000000001',
    league_slug:          'bamsbl',
    question:             'how many outs are needed to retire a half inning',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000002',
    league_slug:          'bamsbl',
    question:             'what constitutes a legal pitch in baseball',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000003',
    league_slug:          'bamsbl',
    question:             'how many balls are required for a base on balls',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000004',
    league_slug:          'bamsbl',
    question:             'what is the definition of the strike zone',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000005',
    league_slug:          'bamsbl',
    question:             'how many defensive players are on the field at one time',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000006',
    league_slug:          'bamsbl',
    question:             'what is the required distance between the bases',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000007',
    league_slug:          'bamsbl',
    question:             'how many warm up pitches does a relief pitcher receive',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'factual',
    tier:                 'critical',
    source:               'human',
  },

  // ── JUDGMENT / MUST CLARIFY (9 new → 10 total with existing ec...-004) ─────
  //
  // All phrased to contain Tier-1 prescreen trigger keywords so routing is
  // deterministic — no LLM classifier dependency.  Trigger keyword noted.

  // Triggers: 'dropped third strike'  → dropped_third_strike matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000008',
    league_slug:          'bamsbl',
    question:             'dropped third strike catcher did not hold the ball',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Triggers: 'popup', 'runners on first and second'  → infield_fly_rule matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000009',
    league_slug:          'bamsbl',
    question:             'popup with runners on first and second and one out',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Trigger: 'collide' (substring of 'collided')  → runner_fielder_collision matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000010',
    league_slug:          'bamsbl',
    question:             'runner collided with the first baseman on a ground ball',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Triggers: 'fair or foul', 'down the line'  → fair_foul_ball matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000011',
    league_slug:          'bamsbl',
    question:             'batted ball fair or foul down the line at third base',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Trigger: 'checked swing'  → check_swing_hbp matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000012',
    league_slug:          'bamsbl',
    question:             'checked swing on a breaking ball in the dirt',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Trigger: 'failed to tag up'  → appeal_play matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000013',
    league_slug:          'bamsbl',
    question:             'runner failed to tag up after the fly ball was caught',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Triggers: 'need to tag', 'force play'  → force_vs_tag matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000014',
    league_slug:          'bamsbl',
    question:             'does the fielder need to tag the runner or is it a force play',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Trigger: 'foul line'  → fair_foul_ball matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000015',
    league_slug:          'bamsbl',
    question:             'ball rolling along the foul line near first base',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  // Trigger: 'blocking'  → runner_fielder_collision matrix
  {
    id:                   'ec000002-0000-0000-0000-000000000016',
    league_slug:          'bamsbl',
    question:             'catcher blocking home plate before the runner arrived',
    expected_state:       'needs_clarification',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },

  // ── JUDGMENT / ENOUGH FACTS (10 new) ─────────────────────────────────────
  //
  // All start with a DEFINITIONAL_PREFIX ('what happens', 'what is the rule').
  // prescreenForMatrix returns null immediately → skip classifier → RAG →
  // expected_state: 'answered'.  These test that clear-cut play scenarios
  // with specific fact patterns can be answered without an interview.

  {
    id:                   'ec000002-0000-0000-0000-000000000017',
    league_slug:          'bamsbl',
    question:             "what is the award to the batter when catcher's interference is called",
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000018',
    league_slug:          'bamsbl',
    question:             'what is the ruling for a runner who is struck by a fair batted ball before it passes an infielder',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000019',
    league_slug:          'bamsbl',
    question:             'what happens when a batter runner goes more than three feet outside the baseline',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000020',
    league_slug:          'bamsbl',
    question:             'what is the penalty when a fielder intentionally uses his cap to field a batted ball',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000021',
    league_slug:          'bamsbl',
    question:             'what happens when a batter overruns first base on a base hit',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000022',
    league_slug:          'bamsbl',
    question:             'what is the rule when a batter intentionally deflects a thrown ball with his bat',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000023',
    league_slug:          'bamsbl',
    question:             'what happens when a batter requests time after the pitcher has started his delivery',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000024',
    league_slug:          'bamsbl',
    question:             'what is the penalty for batting out of order',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000025',
    league_slug:          'bamsbl',
    question:             'what happens when a fair batted ball bounces over the outfield fence',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000026',
    league_slug:          'bamsbl',
    question:             'what is the rule when umpires confer and overturn a call',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'judgment',
    tier:                 'critical',
    source:               'human',
  },

  // ── LOCAL OVERRIDE / LOCAL-SPECIFIC (8 new) ────────────────────────────────
  //
  // Rules specific to BAMSBL that differ from or are absent in the parent rulebook.
  // All expected_state: 'answered' — these should be served from BAMSBL source spans.

  {
    id:                   'ec000002-0000-0000-0000-000000000027',
    league_slug:          'bamsbl',
    question:             'what is the run limit or mercy rule in bamsbl',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000028',
    league_slug:          'bamsbl',
    question:             'is the designated hitter permitted in bamsbl games',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000029',
    league_slug:          'bamsbl',
    question:             'what helmet or safety equipment must bamsbl batters wear',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000030',
    league_slug:          'bamsbl',
    question:             'what bat specifications are approved for bamsbl games',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000031',
    league_slug:          'bamsbl',
    question:             'what are the age or eligibility requirements to play in bamsbl',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000032',
    league_slug:          'bamsbl',
    question:             'how many innings are required for a bamsbl game to be official',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000033',
    league_slug:          'bamsbl',
    question:             'when does a bamsbl team win a game by forfeit',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000034',
    league_slug:          'bamsbl',
    question:             'can a player who has been substituted reenter a bamsbl game',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'override',
    tier:                 'critical',
    source:               'human',
  },

  // ── NO-RULE-FOUND / OUT-OF-SCOPE (5 new) ──────────────────────────────────
  //
  // Topics clearly outside the BAMSBL playing rules (administrative, logistical,
  // or non-baseball topics).  The verifier should return no_rule_found status
  // and the API should return state: 'answered' with an appropriate "not in
  // rulebook" response — never a fabricated rule.

  {
    id:                   'ec000002-0000-0000-0000-000000000035',
    league_slug:          'bamsbl',
    question:             'what is the fee for obtaining a replacement bamsbl rulebook',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'no_rule',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000036',
    league_slug:          'bamsbl',
    question:             'how does bamsbl determine postseason bracket seeding',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'no_rule',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000037',
    league_slug:          'bamsbl',
    question:             'what infield surface material is required for bamsbl fields',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'no_rule',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000038',
    league_slug:          'bamsbl',
    question:             'can bamsbl teams trade players between divisions mid-season',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'no_rule',
    tier:                 'critical',
    source:               'human',
  },
  {
    id:                   'ec000002-0000-0000-0000-000000000039',
    league_slug:          'bamsbl',
    question:             'what is the process for a player to obtain a bamsbl photo identification card',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'no_rule',
    tier:                 'critical',
    source:               'human',
  },

  // ── MISLEADING PHRASING (4 new) ────────────────────────────────────────────
  //
  // Questions worded in ways that might suggest the wrong outcome.
  // All use 'what is the rule when' or 'what happens when' (definitional prefixes)
  // to avoid triggering judgment matrices, since the rulebook has clear answers.

  // Misleading: first base is IN fair territory — the answer is always "fair ball".
  {
    id:                   'ec000002-0000-0000-0000-000000000040',
    league_slug:          'bamsbl',
    question:             'what is the ruling when a batted ball strikes the first base bag',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'misleading',
    tier:                 'critical',
    source:               'human',
  },
  // Misleading: once removed as pitcher, a player cannot return to pitch
  // (though they may remain in the game at another position in some leagues).
  {
    id:                   'ec000002-0000-0000-0000-000000000041',
    league_slug:          'bamsbl',
    question:             'what is the rule when a starting pitcher returns to the mound after being replaced',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'misleading',
    tier:                 'critical',
    source:               'human',
  },
  // Misleading: a fair fly ball that bounces off the top of the fence and clears
  // is a ground rule double, NOT a home run.
  {
    id:                   'ec000002-0000-0000-0000-000000000042',
    league_slug:          'bamsbl',
    question:             'what happens when a fair fly ball bounces off the top of the outfield fence and clears it',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'misleading',
    tier:                 'critical',
    source:               'human',
  },
  // Misleading: a base on balls is not a hit and does not count toward batting average.
  {
    id:                   'ec000002-0000-0000-0000-000000000043',
    league_slug:          'bamsbl',
    question:             'what is the scoring rule for a base on balls in the official statistics',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'misleading',
    tier:                 'critical',
    source:               'human',
  },

  // ── PARENT FALLBACK (3 new) ────────────────────────────────────────────────
  //
  // Rules where BAMSBL may defer to the parent rulebook (MLB OBR or NFHS).
  // All expected_state: 'answered' — BAMSBL source spans should either define the
  // rule or reference the parent; both produce an answered response with sources.

  // Balk rules: standard in MLB OBR, BAMSBL likely adopts by reference.
  {
    id:                   'ec000002-0000-0000-0000-000000000044',
    league_slug:          'bamsbl',
    question:             'what constitutes a balk and what is the penalty',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'parent_fallback',
    tier:                 'critical',
    source:               'human',
  },
  // Coach interference: standard rule adopted from parent.
  {
    id:                   'ec000002-0000-0000-0000-000000000045',
    league_slug:          'bamsbl',
    question:             'what are the rules for a base coach physically assisting a runner',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'parent_fallback',
    tier:                 'critical',
    source:               'human',
  },
  // Foul pole rule: ball hitting the foul pole is a home run — standard rule.
  {
    id:                   'ec000002-0000-0000-0000-000000000046',
    league_slug:          'bamsbl',
    question:             'what is the ruling when a fair batted ball strikes the foul pole',
    expected_state:       'answered',
    expected_rule_number: null,
    expected_source_text: null,
    case_type:            'parent_fallback',
    tier:                 'critical',
    source:               'human',
  },
];

// ── Validate case mix counts ──────────────────────────────────────────────────

const byCaseType = {};
for (const c of EVAL_CASES) {
  byCaseType[c.case_type] = (byCaseType[c.case_type] ?? 0) + 1;
}
const criticalCount = EVAL_CASES.filter(c => c.tier === 'critical').length;
console.log(`\n  Case mix (${EVAL_CASES.length} total, ${criticalCount} critical):`);
for (const [type, count] of Object.entries(byCaseType)) {
  console.log(`    ${type.padEnd(18)} ${count}`);
}

// ── Insert ────────────────────────────────────────────────────────────────────

try {
  let inserted = 0;
  let skipped  = 0;

  for (const c of EVAL_CASES) {
    const res = await client.query(`
      INSERT INTO eval_cases
        (id, league_slug, question, expected_state, expected_rule_number,
         expected_source_text, case_type, tier, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (league_slug, question) DO NOTHING
    `, [
      c.id, c.league_slug, c.question, c.expected_state,
      c.expected_rule_number ?? null, c.expected_source_text ?? null,
      c.case_type, c.tier, c.source,
    ]);

    const stateTag  = c.expected_state.slice(0, 3).toUpperCase();
    const ruleTag   = c.expected_rule_number ? ` [rule=${c.expected_rule_number}]` : '';

    if (res.rowCount > 0) {
      console.log(`  ✓  [${c.tier.padEnd(8)}] ${c.case_type.padEnd(16)} ${stateTag}${ruleTag} — inserted`);
      inserted++;
    } else {
      console.log(`  –  [${c.tier.padEnd(8)}] ${c.case_type.padEnd(16)} ${stateTag}${ruleTag} — already exists`);
      skipped++;
    }
  }

  const total = await client.query(`SELECT COUNT(*) FROM eval_cases WHERE tier = 'critical'`);
  console.log(`\n  Inserted: ${inserted}  Skipped (already present): ${skipped}`);
  console.log(`  Total critical eval_cases rows: ${total.rows[0].count}`);
} catch (err) {
  console.error('  ✗ Seed failed:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
