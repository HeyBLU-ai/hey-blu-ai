/**
 * Re-seeds all five foundation leagues through the updated fine-grained chunker.
 *
 * WHY:
 *   The original seed stored one DB row per top-level rule number (e.g. one row
 *   for all of Rule 5.10, which contains 13 lettered subsections). The updated
 *   retrieval design wants subsection-level rows (5.10(a), 5.10(l), 5.10(m)…)
 *   so that a question about "mound visits per inning" retrieves 5.10(l) directly.
 *
 * HOW:
 *   1. Reads each league's source JSON from api/data/.
 *   2. Splits rule text into lettered subsections using a deterministic regex
 *      (no AI needed — the MLB/LL rule text format is consistent and predictable).
 *   3. Deletes existing rules for the league (cascade removes embeddings).
 *   4. Inserts the new fine-grained rows.
 *   5. Embeds all new rows with text-embedding-3-small.
 *
 * SUBSECTION DETECTION ALGORITHM:
 *   - Finds all `\n(x) ` patterns where x is a SINGLE lowercase letter.
 *   - Starting from `(a)`, collects letters that are strictly sequential.
 *   - Stops at the first non-sequential letter (handles roman numerals like
 *     (i) correctly: after (c), (i) skips d-h so the sequence terminates at (c)).
 *   - Rules with fewer than 2 detected subsections are kept as a single row.
 *
 * Usage:  node api/reseed-leagues.mjs
 */

import { readFile }         from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import pg                   from 'pg';
import { insertRulesTransaction } from './ingest/structure.js';

const { Client } = pg;
const __dirname  = dirname(fileURLToPath(import.meta.url));

const EMBED_MODEL      = 'text-embedding-3-small';
const EMBED_BATCH_SIZE = 50;
const DELAY_MS         = 400;

// ── League processing order ───────────────────────────────────────────────────
// Parents before children so the parent index is populated for override mapping.

const LEAGUES = [
  { slug: 'mlb',           jsonFile: 'rules-mlb.json',                sport: 'baseball' },
  { slug: 'little-league', jsonFile: 'little-league-international.json', sport: 'baseball' },
  { slug: 'usssa',         jsonFile: 'usssa-rules.json',               sport: 'baseball' },
  { slug: 'bamsbl',        jsonFile: 'bamsbl-rules.json',              sport: 'baseball' },
  { slug: 'mill-valley-aaa', jsonFile: 'mill-valley-aaa-rules.json',  sport: 'baseball' },
];

// ── Load .env.local ───────────────────────────────────────────────────────────

try {
  const raw = await readFile(resolve(__dirname, '../.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.error('✗  Could not load .env.local'); process.exit(1);
}

if (!process.env.OPENAI_API_KEY)  { console.error('✗  OPENAI_API_KEY not set'); process.exit(1); }
if (!process.env.DATABASE_URL)    { console.error('✗  DATABASE_URL not set');   process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const DB_CFG = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };

async function withDb(fn) {
  const c = new Client(DB_CFG);
  await c.connect();
  try   { return await fn(c); }
  finally { try { await c.end(); } catch {} }
}

/**
 * Splits a rule's body text into lettered subsections.
 *
 * Returns an array of { subNumber, title, body } objects.
 * If no sequential (a)(b)... pattern is found, returns one entry covering
 * the whole text (no splitting).
 *
 * Example:
 *   "5.10" text has (a)…(m) at top level → 13 entries
 *   "5.02" text has (a)(b)(c) then (i)(ii)(iii) inside (c) →
 *          3 entries; the roman numerals stop the sequence at (c)
 */
function splitSubsections(ruleId, ruleTitle, ruleText) {
  // Match single lowercase letters in (x) at the start of a line.
  // (?:^|\n) covers both the very first character of the text AND mid-text newlines.
  // No leading whitespace allowed so we don't confuse indented sub-sub-clauses.
  const pattern = /(?:^|\n)\(([a-z])\)\s/gm;
  const matches  = [];
  let m;
  while ((m = pattern.exec(ruleText)) !== null) {
    matches.push({ letter: m[1], index: m.index });
  }

  // Filter to sequential run starting from 'a'
  const seq = [];
  let expected = 'a';
  for (const match of matches) {
    if (match.letter !== expected) break;   // non-sequential → stop
    seq.push(match);
    expected = String.fromCharCode(match.letter.charCodeAt(0) + 1);
  }

  // Need at least 2 subsections to bother splitting
  if (seq.length < 2) {
    return [{ subNumber: null, title: ruleTitle, body: ruleText }];
  }

  const subrules = [];
  for (let i = 0; i < seq.length; i++) {
    const start  = seq[i].index;
    const end    = i < seq.length - 1 ? seq[i + 1].index : ruleText.length;
    const body   = ruleText.slice(start, end).trim();
    const letter = seq[i].letter;

    // Extract first sentence/clause of the body to use as the sub-rule title.
    // The body starts with "(x) Some description text..."
    const bodyWithoutLetter = body.replace(/^\([a-z]\)\s*/, '');
    const firstClause       = bodyWithoutLetter.split(/[.;\n]/)[0].trim().slice(0, 200);

    subrules.push({
      subNumber: `${ruleId}(${letter})`,
      title:     firstClause || `${ruleTitle} (${letter})`,
      body,
    });
  }

  return subrules;
}

/**
 * Converts a JSON rule entry (from api/data/*.json) into one or more
 * fine-grained rule objects ready for DB insertion.
 */
function processRule(jsonRule) {
  const { id, title, text } = jsonRule;
  const subs = splitSubsections(id, title, text);

  return subs.map(s => ({
    rule_number:       s.subNumber ?? id,
    title:             s.title,
    body:              s.body,
    is_override:       false,  // override detection not needed for reseed
    overrides_rule_id: null,
    confidence:        1.0,
  }));
}

/** Call OpenAI embeddings API for a batch of strings. */
async function fetchEmbeddings(inputs) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Connectivity check ────────────────────────────────────────────────────────

await withDb(c => c.query('SELECT 1'));
console.log('✓  DB connection OK\n');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Re-chunk and re-insert all leagues
// ─────────────────────────────────────────────────────────────────────────────

const totalInserted = {};

for (const league of LEAGUES) {
  console.log(`${'═'.repeat(60)}`);
  console.log(`  League : ${league.slug}`);
  console.log(`${'─'.repeat(60)}`);

  // ── a. Read source JSON ───────────────────────────────────────────────────

  const jsonPath = resolve(__dirname, 'data', league.jsonFile);
  let sourceRules;
  try {
    sourceRules = JSON.parse(await readFile(jsonPath, 'utf-8'));
  } catch (err) {
    console.error(`  ✗  Could not read ${league.jsonFile}: ${err.message}`); continue;
  }
  console.log(`  Source : ${sourceRules.length} rules from ${league.jsonFile}`);

  // ── b. Split each rule into subsections ───────────────────────────────────

  const fineRules = sourceRules.flatMap(processRule);
  const splitCount = fineRules.length - sourceRules.length;
  console.log(`  Split  : ${sourceRules.length} → ${fineRules.length} chunks` +
    (splitCount > 0 ? ` (+${splitCount} subsections extracted)` : ' (no compound rules found)'));

  // ── c. DB: fetch league UUID, delete existing, insert new ─────────────────
  //    One short-lived connection — no long waits here.

  let inserted;
  try {
    inserted = await withDb(async c => {
      // Fetch league UUID
      const { rows } = await c.query(`SELECT id FROM leagues WHERE slug=$1`, [league.slug]);
      if (rows.length === 0) throw new Error(`League "${league.slug}" not in DB`);
      const leagueId = rows[0].id;

      // Delete existing rules (cascade removes embeddings)
      const del = await c.query(`DELETE FROM rules WHERE league_id=$1 RETURNING id`, [leagueId]);
      console.log(`  Cleared: ${del.rowCount} existing rows`);

      // Insert fine-grained rules
      const { inserted: n, skipped } = await insertRulesTransaction(c, fineRules, leagueId, league.sport);
      if (skipped.length > 0) {
        console.log(`  ⚠  ${skipped.length} skipped (ON CONFLICT):`,
          skipped.map(s => s.rule_number).slice(0, 5).join(', '));
      }
      return n;
    });
  } catch (err) {
    console.error(`  ✗  DB operation failed: ${err.message}`); continue;
  }

  totalInserted[league.slug] = inserted;
  console.log(`  Inserted: ${inserted} rules`);
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Embed all new rule rows
// ─────────────────────────────────────────────────────────────────────────────

console.log(`${'═'.repeat(60)}`);
console.log('  PHASE 2: Embedding new rules');
console.log(`${'─'.repeat(60)}`);

const { rows: unembedded } = await withDb(c => c.query(`
  SELECT r.id, r.rule_number, r.title, r.body, l.name AS league_name
  FROM  rules r
  JOIN  leagues l ON l.id = r.league_id
  LEFT  JOIN rule_embeddings re ON re.rule_id = r.id AND re.model = $1
  WHERE re.id IS NULL
  ORDER BY l.name, r.rule_number::text
`, [EMBED_MODEL]));

console.log(`  ${unembedded.length} rules need embeddings\n`);

const embedBatches  = chunk(unembedded, EMBED_BATCH_SIZE);
let   totalEmbedded = 0;

for (let bIdx = 0; bIdx < embedBatches.length; bIdx++) {
  const batch = embedBatches[bIdx];
  process.stdout.write(`  Embedding batch ${bIdx + 1}/${embedBatches.length} (${batch.length} rules)… `);

  let embeddings;
  try {
    const inputs = batch.map(r => `Rule ${r.rule_number}: ${r.title}\n\n${r.body}`.trim());
    embeddings   = await fetchEmbeddings(inputs);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    if (bIdx < embedBatches.length - 1) await sleep(DELAY_MS);
    continue;
  }

  try {
    await withDb(async c => {
      await c.query('BEGIN');
      for (let i = 0; i < batch.length; i++) {
        await c.query(
          `INSERT INTO rule_embeddings (rule_id, model, embedding)
           VALUES ($1, $2, $3::vector)
           ON CONFLICT (rule_id, model) DO NOTHING`,
          [batch[i].id, EMBED_MODEL, `[${embeddings[i].join(',')}]`],
        );
      }
      await c.query('COMMIT');
    });
    totalEmbedded += batch.length;
    console.log(`done  (${totalEmbedded}/${unembedded.length} total)`);
  } catch (err) {
    console.error(`DB insert FAILED: ${err.message}`);
  }

  if (bIdx < embedBatches.length - 1) await sleep(DELAY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

const { rows: [{ count: ruleCount }]  } = await withDb(c => c.query(`SELECT COUNT(*) AS count FROM rules`));
const { rows: [{ count: embedCount }] } = await withDb(c =>
  c.query(`SELECT COUNT(*) AS count FROM rule_embeddings WHERE model=$1`, [EMBED_MODEL]));

console.log(`\n${'═'.repeat(60)}`);
console.log('  SUMMARY');
console.log(`${'─'.repeat(60)}`);
for (const l of LEAGUES) {
  const n = totalInserted[l.slug] ?? 'n/a';
  console.log(`  ${l.slug.padEnd(18)} inserted: ${String(n).padStart(4)}`);
}
console.log(`${'─'.repeat(60)}`);
console.log(`  Total rules in DB     : ${ruleCount}`);
console.log(`  Total embeddings in DB: ${embedCount}`);
console.log(`${'═'.repeat(60)}\n`);
