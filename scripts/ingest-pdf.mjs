#!/usr/bin/env node
/**
 * ingest-pdf.mjs  —  Local rulebook ingestion. No Vercel. No timeouts.
 *
 * Usage:
 *   node scripts/ingest-pdf.mjs <pdf-path> <league-slug> [--replace] [--sport baseball|softball]
 *
 * Examples:
 *   node scripts/ingest-pdf.mjs 2026bamsblrules.pdf bamsbl --replace
 *   node scripts/ingest-pdf.mjs rulebook.pdf little-league --replace --sport baseball
 *
 * Reads .env.local for DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY.
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg         from 'pg';
import Anthropic  from '@anthropic-ai/sdk';

const { Client } = pg;
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');

// ── 1. Load .env.local ────────────────────────────────────────────────────────

console.log('\n━━━  HeyBLU PDF Ingest  ━━━\n');
console.log('► Step 1: Loading environment variables from .env.local…');

try {
  const raw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq  = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('  ✓ .env.local loaded');
} catch {
  console.error('  ✗ .env.local not found. Run: vercel env pull .env.local');
  process.exit(1);
}

const { DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY } = process.env;

if (!DATABASE_URL)    { console.error('  ✗ DATABASE_URL not set');    process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('  ✗ ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!OPENAI_API_KEY)  { console.error('  ✗ OPENAI_API_KEY not set');  process.exit(1); }
console.log('  ✓ All required env vars present\n');

// ── 2. Parse CLI args ─────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const pdfArg     = args.find(a => !a.startsWith('--') && !['baseball','softball'].includes(a.toLowerCase()) && args.indexOf(a) < 2);
const leagueSlug = args.find(a => !a.startsWith('--') && !['baseball','softball'].includes(a.toLowerCase()) && args.indexOf(a) >= 1 && a !== pdfArg);
const doReplace  = args.includes('--replace');
const sportIdx   = args.indexOf('--sport');
const sport      = sportIdx >= 0 ? args[sportIdx + 1] : 'baseball';

if (!pdfArg || !leagueSlug) {
  console.error('Usage: node scripts/ingest-pdf.mjs <pdf-path> <league-slug> [--replace] [--sport baseball|softball]');
  process.exit(1);
}

const pdfPath = path.isAbsolute(pdfArg) ? pdfArg : path.join(process.cwd(), pdfArg);

console.log(`► PDF:    ${pdfPath}`);
console.log(`► League: ${leagueSlug}`);
console.log(`► Sport:  ${sport}`);
console.log(`► Replace existing rules: ${doReplace}\n`);

// ── 3. Read PDF ───────────────────────────────────────────────────────────────

console.log('► Step 2: Reading PDF file…');
let pdfBuffer;
try {
  pdfBuffer = await fs.readFile(pdfPath);
  const sizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(2);
  console.log(`  ✓ Read ${sizeMB} MB (${pdfBuffer.length.toLocaleString()} bytes)`);
} catch (err) {
  console.error(`  ✗ Cannot read file: ${err.message}`);
  process.exit(1);
}
const fileBase64 = pdfBuffer.toString('base64');
console.log();

// ── 4. DB: look up league + parent rules ─────────────────────────────────────

console.log('► Step 3: Looking up league in database…');
const db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const leagueRes = await db.query(`
  SELECT l.id, l.name, l.parent_league_id,
         p.id AS parent_id, p.name AS parent_name
  FROM leagues l LEFT JOIN leagues p ON p.id = l.parent_league_id
  WHERE l.slug = $1
`, [leagueSlug]);

if (!leagueRes.rows.length) {
  console.error(`  ✗ League slug "${leagueSlug}" not found in DB.`);
  const all = await db.query('SELECT slug, name FROM leagues ORDER BY name');
  console.log('  Available leagues:');
  all.rows.forEach(r => console.log(`    • ${r.slug}  (${r.name})`));
  await db.end();
  process.exit(1);
}

const { id: leagueId, name: leagueName, parent_id: parentId, parent_name: parentName } = leagueRes.rows[0];
console.log(`  ✓ Found: "${leagueName}"`);
if (parentName) console.log(`  ✓ Parent: "${parentName}"`);

let parentIndex = [];
if (parentId) {
  const pr = await db.query(
    `SELECT id, rule_number, title FROM rules WHERE league_id=$1 AND (sport=$2 OR sport='baseball') ORDER BY rule_number`,
    [parentId, sport],
  );
  parentIndex = pr.rows;
  console.log(`  ✓ ${parentIndex.length} parent rules loaded for override detection`);
}
console.log();

// ── 5. Send PDF to Claude ─────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting the complete rulebook for "${leagueName}" (sport: ${sport}).
${parentName ? `This league is based on "${parentName}" rules and may contain local overrides or additions.` : ''}

Read this PDF carefully. For EVERY rule, regulation, and local modification in the document, extract:

- rule_number: The official identifier (e.g. "1.01", "Rule 5", "Section 3", "MUST-SLIDE"). Use the document's own numbering. If a rule has no number, create a short descriptive slug.
- title: 3–8 word descriptive title capturing the rule's topic.
- body: Concise 40–100 word summary. Capture every key fact, number, distance, count, and exception. Do NOT copy verbatim — write a clear, searchable summary an umpire could look up.
- is_override: true ONLY if this rule explicitly modifies a rule from the parent rulebook (${parentName ?? 'MLB OBR'}). Local additions are NOT overrides.
- override_parent_rule_number: Parent rule number being modified, or null.
- confidence: "high" if rule boundary is clear, "medium" if uncertain, "low" if guessing.

IMPORTANT:
- Extract EVERY rule — do not skip minor ones.
- Split lettered sub-sections (a), (b), (c) into separate objects when each covers a distinct independently-searchable topic.
- Skip table of contents, page headers/footers, and administrative preamble.

Return your entire response as a single JSON object:
{"rules": [...], "document_quality": "good|partial|poor", "notes": "..."}`;

console.log('► Step 4: Sending PDF to Claude Sonnet 4.6…');
console.log('  (This takes 1–3 minutes. Progress will appear below.)\n');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
let dots = 0;
const ticker = setInterval(() => {
  process.stdout.write(dots % 30 === 0 ? '\n  ' : '.');
  dots++;
}, 2000);

let rawResponse;
try {
  const stream = anthropic.messages.stream({
    model:      'claude-sonnet-4-6',
    max_tokens: 64000,
    messages: [{
      role:    'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
        { type: 'text',     text: EXTRACTION_PROMPT },
      ],
    }],
  });

  const response = await stream.finalMessage();
  rawResponse    = response.content[0]?.text ?? '';
} finally {
  clearInterval(ticker);
  process.stdout.write('\n');
}

if (!rawResponse) {
  console.error('\n  ✗ Claude returned an empty response.');
  await db.end();
  process.exit(1);
}

console.log(`\n  ✓ Claude responded (${rawResponse.length.toLocaleString()} chars)`);

// ── 6. Parse JSON ─────────────────────────────────────────────────────────────

console.log('\n► Step 5: Parsing extracted rules…');

const start    = rawResponse.indexOf('{');
const end      = rawResponse.lastIndexOf('}');
if (start === -1 || end === -1 || end <= start) {
  console.error('  ✗ No JSON object found in Claude response.');
  console.error('  Raw response preview:', rawResponse.slice(0, 500));
  await db.end();
  process.exit(1);
}

let extracted;
try {
  extracted = JSON.parse(rawResponse.slice(start, end + 1));
} catch (err) {
  console.error('  ✗ JSON parse error:', err.message);
  console.error('  Raw preview:', rawResponse.slice(start, start + 500));
  await db.end();
  process.exit(1);
}

const rawRules  = extracted.rules ?? [];
const validRules = rawRules.filter(r => r.rule_number && r.title && r.body);

console.log(`  ✓ ${validRules.length} valid rules extracted (${rawRules.length - validRules.length} skipped as invalid)`);
console.log(`  ✓ Document quality: ${extracted.document_quality ?? 'unknown'}`);
if (extracted.notes) console.log(`  ✓ Notes: ${extracted.notes}`);

if (validRules.length === 0) {
  console.error('  ✗ No valid rules found. Aborting.');
  await db.end();
  process.exit(1);
}

// Preview first 5 rules
console.log('\n  Preview (first 5 rules):');
validRules.slice(0, 5).forEach(r =>
  console.log(`    [${r.rule_number}] ${r.title}`)
);
console.log();

// ── 7. Write to DB ────────────────────────────────────────────────────────────

console.log('► Step 6: Writing rules to database…');

const parentMap = Object.fromEntries(parentIndex.map(p => [p.rule_number, p.id]));

if (doReplace) {
  const del = await db.query(`DELETE FROM rules WHERE league_id=$1 RETURNING id`, [leagueId]);
  console.log(`  ✓ Cleared ${del.rowCount} existing rules`);
}

const rulesForInsert = validRules.map(r => ({
  rule_number:       String(r.rule_number).trim().slice(0, 100),
  title:             String(r.title).trim().slice(0, 500),
  body:              String(r.body).trim(),
  is_override:       !!r.is_override,
  overrides_rule_id: r.is_override && r.override_parent_rule_number
    ? (parentMap[r.override_parent_rule_number] ?? null) : null,
  confidence:        r.confidence ?? null,
}));

// Insert in a single transaction
let inserted = 0;
let skipped  = 0;
await db.query('BEGIN');
try {
  for (const rule of rulesForInsert) {
    const res = await db.query(`
      INSERT INTO rules (league_id, rule_number, title, body, sport, is_override, overrides_rule_id, confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (league_id, rule_number, sport) DO NOTHING
      RETURNING id
    `, [leagueId, rule.rule_number, rule.title, rule.body, sport, rule.is_override, rule.overrides_rule_id, rule.confidence]);
    if (res.rowCount > 0) inserted++; else skipped++;
  }
  await db.query('COMMIT');
  console.log(`  ✓ Inserted: ${inserted}  Skipped (already exist): ${skipped}`);
} catch (err) {
  await db.query('ROLLBACK');
  console.error('  ✗ DB insert failed:', err.message);
  await db.end();
  process.exit(1);
}

// ── 8. Embed rules ────────────────────────────────────────────────────────────

console.log('\n► Step 7: Generating embeddings…');

const EMBED_MODEL  = 'text-embedding-3-small';
const EMBED_BATCH  = 50;

const unembedded = await db.query(`
  SELECT r.id, r.rule_number, r.title, r.body
  FROM  rules r
  LEFT  JOIN rule_embeddings re ON re.rule_id=r.id AND re.model=$1
  WHERE r.league_id=$2 AND re.id IS NULL
`, [EMBED_MODEL, leagueId]);

const toEmbed = unembedded.rows;
console.log(`  ✓ ${toEmbed.length} rules need embeddings`);

if (toEmbed.length > 0) {
  const batches = [];
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) batches.push(toEmbed.slice(i, i + EMBED_BATCH));

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    process.stdout.write(`  Embedding batch ${bIdx + 1}/${batches.length}… `);

    const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model: EMBED_MODEL,
        input: batch.map(r => `Rule ${r.rule_number}: ${r.title}\n\n${r.body}`.trim()),
      }),
    });

    if (!embedRes.ok) {
      console.error(`\n  ✗ Embedding API error: ${embedRes.status}`);
      continue;
    }

    const { data: embedData } = await embedRes.json();
    await db.query('BEGIN');
    for (let i = 0; i < batch.length; i++) {
      await db.query(
        `INSERT INTO rule_embeddings (rule_id,model,embedding) VALUES ($1,$2,$3::vector) ON CONFLICT DO NOTHING`,
        [batch[i].id, EMBED_MODEL, `[${embedData[i].embedding.join(',')}]`],
      );
    }
    await db.query('COMMIT');
    console.log(`done (${batch.length} rules)`);
  }
}

// ── 9. Done ───────────────────────────────────────────────────────────────────

await db.end();

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✅  DONE — ${inserted} rules live in "${leagueName}"`);
console.log(`   Sport: ${sport}  |  Embeddings: ${toEmbed.length}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log(`Test it: https://heyblu.ai/rulebook\n`);
