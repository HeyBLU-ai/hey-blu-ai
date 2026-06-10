/**
 * Embedding pipeline — populates the rule_embeddings table.
 *
 * Reads every rule from the rules table that doesn't yet have an embedding,
 * calls OpenAI text-embedding-3-small in batches, and bulk-inserts the
 * vectors into rule_embeddings.
 *
 * Safe to re-run: already-embedded rules are skipped via the LEFT JOIN check.
 * ON CONFLICT DO NOTHING prevents duplicate key errors.
 *
 * Usage: node api/embed-rules.mjs
 */

import { readFile }      from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg                from 'pg';

const { Client } = pg;
const __dirname  = dirname(fileURLToPath(import.meta.url));

const MODEL      = 'text-embedding-3-small';
const BATCH_SIZE = 50;      // rules per OpenAI request (max 2048; 50 is safe)
const DELAY_MS   = 500;     // pause between batches (ms)

// ── Load .env.local ──────────────────────────────────────────────────────────

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

/** Build the text that gets embedded for a single rule. */
function embedText(rule) {
  return `Rule ${rule.rule_number}: ${rule.title}\n\n${rule.body}`.trim();
}

/** Call OpenAI embeddings API for a batch of input strings. */
async function fetchEmbeddings(inputs) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.data.map(d => d.embedding); // array of float[] aligned with inputs
}

/** Chunk an array into subarrays of at most `size`. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Sleep for ms milliseconds. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Connect ───────────────────────────────────────────────────────────────────

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log('✓  Connected to database\n');

// ── Fetch rules that need embeddings ─────────────────────────────────────────

const { rows: rules } = await client.query(`
  SELECT
    r.id,
    r.rule_number,
    r.title,
    r.body,
    l.name AS league_name,
    l.slug AS league_slug
  FROM  rules r
  JOIN  leagues l ON l.id = r.league_id
  LEFT  JOIN rule_embeddings re
        ON re.rule_id = r.id AND re.model = $1
  WHERE re.id IS NULL
  ORDER BY l.name, r.rule_number::text
`, [MODEL]);

if (rules.length === 0) {
  console.log('  All rules already have embeddings. Nothing to do.\n');
  await client.end();
  process.exit(0);
}

console.log(`  ${rules.length} rules need embeddings (model: ${MODEL})\n`);

// Print breakdown by league
const byLeague = {};
for (const r of rules) {
  byLeague[r.league_name] = (byLeague[r.league_name] ?? 0) + 1;
}
for (const [name, count] of Object.entries(byLeague)) {
  console.log(`    ${count.toString().padStart(3)} rules  —  ${name}`);
}
console.log();

// ── Embed in batches ──────────────────────────────────────────────────────────

const batches    = chunk(rules, BATCH_SIZE);
let   totalDone  = 0;
let   totalFailed = 0;

for (let bIdx = 0; bIdx < batches.length; bIdx++) {
  const batch   = batches[bIdx];
  const label   = `Batch ${bIdx + 1}/${batches.length} (${batch.length} rules)`;
  process.stdout.write(`  ${label}… `);

  let embeddings;
  try {
    const inputs = batch.map(embedText);
    embeddings   = await fetchEmbeddings(inputs);
  } catch (err) {
    console.error(`FAILED\n    ✗  ${err.message}`);
    totalFailed += batch.length;
    if (bIdx < batches.length - 1) await sleep(DELAY_MS);
    continue;
  }

  // Bulk insert this batch in a single transaction
  await client.query('BEGIN');
  let batchInserted = 0;
  try {
    for (let i = 0; i < batch.length; i++) {
      const rule      = batch[i];
      const embedding = embeddings[i];
      const vecStr    = `[${embedding.join(',')}]`;

      await client.query(`
        INSERT INTO rule_embeddings (rule_id, model, embedding)
        VALUES ($1, $2, $3::vector)
        ON CONFLICT (rule_id, model) DO NOTHING
      `, [rule.id, MODEL, vecStr]);

      batchInserted++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED (DB insert)\n    ✗  ${err.message}`);
    totalFailed += batch.length;
    if (bIdx < batches.length - 1) await sleep(DELAY_MS);
    continue;
  }

  totalDone += batchInserted;
  console.log(`done  (${totalDone}/${rules.length} total)`);

  if (bIdx < batches.length - 1) await sleep(DELAY_MS);
}

// ── Final verification ────────────────────────────────────────────────────────

const { rows: [{ count: embCount }] } = await client.query(
  `SELECT COUNT(*) AS count FROM rule_embeddings WHERE model = $1`, [MODEL]
);

console.log(`\n${'─'.repeat(52)}`);
console.log(`  Embedded : ${totalDone}`);
if (totalFailed > 0) console.log(`  Failed   : ${totalFailed}`);
console.log(`  DB total : ${embCount} embeddings (${MODEL})`);
console.log(`${'─'.repeat(52)}\n`);

if (totalFailed === 0) {
  console.log('  ✓  Embedding pipeline complete. ask-v2 can now use pgvector.\n');
} else {
  console.log('  ⚠  Some rules failed. Re-run to retry (already-done rows are skipped).\n');
}

await client.end();
