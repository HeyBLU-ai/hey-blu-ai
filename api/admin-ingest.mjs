/**
 * League Admin Ingestion CLI
 *
 * Wraps the full ingest pipeline into one command:
 *   parse (URL or file) → AI chunk → subsection split → DB insert → embed
 *
 * Usage:
 *   node api/admin-ingest.mjs --url <url>  --league <slug>  [--replace] [--sport baseball]
 *   node api/admin-ingest.mjs --file <path> --league <slug>  [--replace] [--sport baseball]
 *   node api/admin-ingest.mjs --url <url>  --new-league <name> [--parent <slug>] [--sport baseball]
 *
 * Options:
 *   --url <url>            Public URL of the rulebook (HTML or PDF link via Jina Reader)
 *   --file <path>          Local .pdf or .docx file path
 *   --league <slug>        Existing league slug (mlb | little-league | usssa | bamsbl | mill-valley-aaa)
 *   --new-league <name>    Create a new league with this display name (also set --slug)
 *   --slug <slug>          DB slug for --new-league (kebab-case, e.g. "my-league-2026")
 *   --parent <slug>        Parent league slug for hierarchy/override detection
 *   --sport <sport>        baseball | softball  (default: baseball)
 *   --replace              Delete existing rules before inserting (default: append only)
 *   --dry-run              Parse and chunk but do not write to DB
 */

import { readFile }         from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import pg                   from 'pg';
import OpenAI               from 'openai';
import {
  callChunkingAgent,
  insertRulesTransaction,
  splitIntoSections,
  chunk,
} from './ingest/structure.js';

const { Client } = pg;
const __dirname  = dirname(fileURLToPath(import.meta.url));

const EMBED_MODEL      = 'text-embedding-3-small';
const EMBED_BATCH_SIZE = 50;
const DELAY_MS         = 400;
const JINA_BASE        = 'https://r.jina.ai/';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function hasFlag(flag) { return args.includes(flag); }

const inputUrl    = getArg('--url');
const inputFile   = getArg('--file');
const leagueSlug  = getArg('--league');
const newLeague   = getArg('--new-league');
const newSlug     = getArg('--slug');
const parentSlug  = getArg('--parent');
const sport       = getArg('--sport') ?? 'baseball';
const doReplace   = hasFlag('--replace');
const dryRun      = hasFlag('--dry-run');

// Validate
if (!inputUrl && !inputFile) {
  console.error('✗  Provide --url <url> or --file <path>');
  console.error('   Example: node api/admin-ingest.mjs --url https://... --league mlb --replace');
  process.exit(1);
}
if (!leagueSlug && !newLeague) {
  console.error('✗  Provide --league <slug> (existing) or --new-league <name> (creates new)');
  process.exit(1);
}
if (newLeague && !newSlug) {
  console.error('✗  --new-league requires --slug <kebab-slug>');
  process.exit(1);
}
if (!['baseball', 'softball', 'both'].includes(sport)) {
  console.error('✗  --sport must be baseball | softball | both');
  process.exit(1);
}

// ── Load .env.local ───────────────────────────────────────────────────────────

try {
  const raw = await readFile(resolve(__dirname, '../.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch {
  console.error('✗  Could not load .env.local'); process.exit(1);
}

if (!process.env.OPENAI_API_KEY)  { console.error('✗  OPENAI_API_KEY not set'); process.exit(1); }
if (!process.env.DATABASE_URL)    { console.error('✗  DATABASE_URL not set');   process.exit(1); }

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DB_CFG  = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
const sleep   = ms => new Promise(r => setTimeout(r, ms));

async function withDb(fn) {
  const c = new Client(DB_CFG);
  await c.connect();
  try   { return await fn(c); }
  finally { try { await c.end(); } catch {} }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Parse the input into Markdown
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  STEP 1: Parse input');
console.log('─'.repeat(60));

let markdown;
let parseMethod;

if (inputUrl) {
  console.log(`  Source : ${inputUrl}`);
  console.log('  Method : Jina Reader (URL → Markdown)');
  process.stdout.write('  Fetching… ');

  const jinaUrl = `${JINA_BASE}${inputUrl}`;
  const res = await fetch(jinaUrl, { headers: { Accept: 'text/markdown' } });

  if (!res.ok) {
    console.error(`\n✗  Jina Reader returned HTTP ${res.status}. URL may be gated or invalid.`);
    process.exit(1);
  }

  const raw = await res.text();
  if (!raw || raw.trim().length < 100) {
    console.error('\n✗  Jina Reader returned empty content. Page may require JS or authentication.');
    process.exit(1);
  }

  markdown    = normalizeMarkdown(raw, inputUrl);
  parseMethod = 'jina-reader';
  console.log(`done (${(raw.length / 1024).toFixed(1)} KB raw, ${markdown.split('\n').length} lines)`);

} else {
  // Local file
  const absPath = resolve(process.cwd(), inputFile);
  const ext     = inputFile.split('.').pop().toLowerCase();
  console.log(`  Source : ${absPath}`);

  if (ext === 'pdf') {
    if (!process.env.LLAMA_CLOUD_API_KEY) {
      console.error('✗  LLAMA_CLOUD_API_KEY not set — required for PDF parsing');
      process.exit(1);
    }
    console.log('  Method : LlamaParse (PDF → Markdown)');
    process.stdout.write('  Uploading to LlamaCloud… ');

    const { default: LlamaCloud } = await import('@llamaindex/llama-cloud');
    const buffer = await readFile(absPath);
    const client = new LlamaCloud({ apiKey: process.env.LLAMA_CLOUD_API_KEY });

    const uploaded = await client.files.create({
      file:    new File([buffer], inputFile.split('/').pop(), { type: 'application/pdf' }),
      purpose: 'parse',
    });
    console.log('done');
    process.stdout.write('  Parsing (this takes 30–90 s)… ');

    const result = await client.parsing.parse({
      file_id: uploaded.id,
      tier:    'agentic',
      version: 'latest',
      expand:  ['markdown_full'],
    });

    const raw = result?.markdown_full ?? result?.markdown?.pages?.map(p => p.markdown).join('\n\n') ?? '';
    if (!raw || raw.trim().length < 100) {
      console.error('\n✗  LlamaParse returned empty result. PDF may be image-only or password-protected.');
      process.exit(1);
    }
    markdown    = normalizeMarkdown(raw, inputFile);
    parseMethod = 'llamaparse-agentic';
    console.log(`done (${(raw.length / 1024).toFixed(1)} KB)`);

  } else if (ext === 'docx') {
    console.log('  Method : mammoth (DOCX → Markdown)');
    const { default: mammoth } = await import('mammoth');
    const buffer = await readFile(absPath);
    const result = await mammoth.convertToHtml({ buffer }, {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
      ],
    });
    markdown    = normalizeMarkdown(htmlToMarkdown(result.value), inputFile);
    parseMethod = 'mammoth-docx';
    console.log(`done (${(result.value.length / 1024).toFixed(1)} KB HTML)`);

  } else {
    console.error(`✗  Unsupported file type ".${ext}". Supported: .pdf .docx`);
    process.exit(1);
  }
}

const sections = splitIntoSections(markdown);
console.log(`  Sections detected: ${sections.length}`);

if (sections.length < 2) {
  console.error('\n✗  Fewer than 2 ## sections found in parsed Markdown.');
  console.error('   The document may not have numbered rule sections, or parsing failed to\n' +
                '   promote rule headings to ## format. Review the raw Markdown:');
  console.error(markdown.slice(0, 500));
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Resolve or create league in DB
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  STEP 2: Resolve league');
console.log('─'.repeat(60));

let leagueId, leagueName, parentId, parentName, parentIndex = [];

await withDb(async c => {
  if (newLeague) {
    // Optionally find parent
    let pid = null, pname = null;
    if (parentSlug) {
      const { rows } = await c.query(`SELECT id, name FROM leagues WHERE slug=$1`, [parentSlug]);
      if (rows.length === 0) {
        console.error(`✗  Parent league "${parentSlug}" not found`); process.exit(1);
      }
      pid   = rows[0].id;
      pname = rows[0].name;
    }

    // Upsert the new league
    const { rows } = await c.query(`
      INSERT INTO leagues (slug, name, parent_league_id, is_foundation, effective_date)
      VALUES ($1, $2, $3, $4, CURRENT_DATE)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, parent_league_id = EXCLUDED.parent_league_id
      RETURNING id, name
    `, [newSlug, newLeague, pid, pid === null]);

    leagueId   = rows[0].id;
    leagueName = rows[0].name;
    parentId   = pid;
    parentName = pname;
    console.log(`  Created/updated league: "${leagueName}" (slug: ${newSlug})`);

  } else {
    const { rows } = await c.query(`
      SELECT l.id, l.name, l.parent_league_id,
             p.id AS parent_id, p.name AS parent_name
      FROM leagues l LEFT JOIN leagues p ON p.id = l.parent_league_id
      WHERE l.slug = $1
    `, [leagueSlug]);

    if (rows.length === 0) {
      console.error(`✗  League "${leagueSlug}" not found. Use --new-league to create it.`);
      process.exit(1);
    }

    leagueId   = rows[0].id;
    leagueName = rows[0].name;
    parentId   = rows[0].parent_id;
    parentName = rows[0].parent_name;
    console.log(`  League: "${leagueName}" (slug: ${leagueSlug})`);
  }

  if (parentId) {
    const { rows: pRows } = await c.query(
      `SELECT id, rule_number, title FROM rules WHERE league_id=$1 AND (sport=$2 OR sport='baseball') ORDER BY rule_number`,
      [parentId, sport],
    );
    parentIndex = pRows;
    console.log(`  Parent: "${parentName}" (${parentIndex.length} rules for override detection)`);
  } else {
    console.log(`  Parent: none (foundation/standalone rulebook)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — AI chunking
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  STEP 3: AI chunk extraction');
console.log(`─`.repeat(60));
console.log(`  ${sections.length} sections → batches of 25`);

const BATCH_SIZE = 25;
const batches    = chunk(sections, BATCH_SIZE);
const allRules   = [];
let worstQuality = 'good';

for (let bIdx = 0; bIdx < batches.length; bIdx++) {
  process.stdout.write(`  Batch ${bIdx + 1}/${batches.length}… `);
  try {
    const result = await callChunkingAgent(openai, {
      sections:    batches[bIdx],
      leagueName,
      parentName:  parentName ?? null,
      parentIndex,
      sport,
      batchLabel:  `batch ${bIdx + 1}/${batches.length}`,
    });
    allRules.push(...(result.rules ?? []));
    if (result.document_quality === 'poor'    ||
        (result.document_quality === 'partial' && worstQuality === 'good')) {
      worstQuality = result.document_quality;
    }
    console.log(`done (${result.rules?.length ?? 0} rules, quality: ${result.document_quality})`);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
  }
  if (bIdx < batches.length - 1) await sleep(DELAY_MS);
}

const validRules = allRules.filter(r => r.rule_number && r.title && r.body);
console.log(`  Extracted: ${validRules.length} valid rules (${allRules.length - validRules.length} failed shape check)`);

if (validRules.length === 0) {
  console.error('\n✗  No valid rules extracted. The document may lack rule structure.');
  process.exit(1);
}

if (dryRun) {
  console.log('\n  --dry-run: stopping before DB write.');
  console.log(`  Would insert ${validRules.length} rules into league "${leagueName}"`);
  validRules.slice(0, 10).forEach(r =>
    console.log(`    ${r.rule_number.padEnd(12)} ${r.title.slice(0, 60)}`));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Delete existing rules (if --replace) and insert
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  STEP 4: Write to database');
console.log('─'.repeat(60));

const parentMap = Object.fromEntries(parentIndex.map(p => [p.rule_number, p.id]));

const rulesForInsert = validRules.map(r => ({
  rule_number:       String(r.rule_number).trim().slice(0, 100),
  title:             String(r.title).trim().slice(0, 500),
  body:              String(r.body).trim(),
  is_override:       !!r.is_override,
  overrides_rule_id: r.is_override && r.override_parent_rule_number
    ? (parentMap[r.override_parent_rule_number] ?? null)
    : null,
  confidence:        r.confidence ?? null,
}));

let inserted, skipped;
await withDb(async c => {
  if (doReplace) {
    const del = await c.query(`DELETE FROM rules WHERE league_id=$1 RETURNING id`, [leagueId]);
    console.log(`  Cleared: ${del.rowCount} existing rules (+ their embeddings)`);
  }

  const result = await insertRulesTransaction(c, rulesForInsert, leagueId, sport);
  inserted = result.inserted;
  skipped  = result.skipped;
});

console.log(`  Inserted: ${inserted} rules`);
if (skipped.length > 0) {
  console.log(`  Skipped (already exists): ${skipped.length} — use --replace to overwrite`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Embed new rules
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  STEP 5: Embed new rules');
console.log('─'.repeat(60));

const { rows: unembedded } = await withDb(c => c.query(`
  SELECT r.id, r.rule_number, r.title, r.body
  FROM  rules r
  LEFT  JOIN rule_embeddings re ON re.rule_id = r.id AND re.model = $1
  WHERE r.league_id = $2 AND re.id IS NULL
  ORDER BY r.rule_number::text
`, [EMBED_MODEL, leagueId]));

if (unembedded.length === 0) {
  console.log('  All rules already embedded.');
} else {
  console.log(`  ${unembedded.length} rules need embeddings`);
  const embedBatches = chunk(unembedded, EMBED_BATCH_SIZE);
  let totalEmbedded  = 0;

  for (let bIdx = 0; bIdx < embedBatches.length; bIdx++) {
    const batch = embedBatches[bIdx];
    process.stdout.write(`  Embedding batch ${bIdx + 1}/${embedBatches.length}… `);

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model: EMBED_MODEL,
        input: batch.map(r => `Rule ${r.rule_number}: ${r.title}\n\n${r.body}`.trim()),
      }),
    });

    if (!res.ok) { console.error(`FAILED (${res.status})`); continue; }
    const embedData  = await res.json();
    const embeddings = embedData.data.map(d => d.embedding);

    await withDb(async c => {
      await c.query('BEGIN');
      for (let i = 0; i < batch.length; i++) {
        await c.query(
          `INSERT INTO rule_embeddings (rule_id, model, embedding)
           VALUES ($1, $2, $3::vector) ON CONFLICT (rule_id, model) DO NOTHING`,
          [batch[i].id, EMBED_MODEL, `[${embeddings[i].join(',')}]`],
        );
      }
      await c.query('COMMIT');
    });

    totalEmbedded += batch.length;
    console.log(`done  (${totalEmbedded}/${unembedded.length} total)`);
    if (bIdx < embedBatches.length - 1) await sleep(DELAY_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DONE
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('  DONE');
console.log('─'.repeat(60));
console.log(`  League   : ${leagueName}`);
console.log(`  Inserted : ${inserted} rules`);
console.log(`  Parse    : ${parseMethod}`);
console.log(`  Quality  : ${worstQuality}`);
console.log(`\n  Test it now:`);
const testSlug = leagueSlug ?? newSlug;
console.log(`  Ask a question at http://localhost:3000/rulebook`);
console.log(`  Select league: "${leagueName}"`);
console.log('═'.repeat(60) + '\n');

// ─────────────────────────────────────────────────────────────────────────────
// Utilities (subset of parse.js, kept local so no HTTP round-trip needed)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeMarkdown(raw, sourceName) {
  let md = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  md = md.replace(
    /^(?!#)(\s*)(Rule\s+\d+[\.\d]*[a-z]?|Section\s+\d+|Article\s+[IVXLC]+|\d+\.\d+[a-z]?|[A-Z][A-Z\s]{2,48})\s*[-–—:]?\s*$/gim,
    '$1## $2\n',
  );
  md = md.replace(/\n{3,}/g, '\n\n');
  return (`<!-- ingested from: ${sourceName.replace(/-->/g, '->')} -->\n\n` + md).trim();
}

function htmlToMarkdown(html) {
  return html
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/?[ou]l[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ── Vercel serverless export — this file is a CLI tool only ──────────────────
// If somehow invoked as a Vercel route, return 410 Gone.
export default function handler(_req, res) {
  return res.status(410).json({
    error:      'endpoint_deprecated',
    message:    'api/admin-ingest is a CLI-only tool and is not accessible as an HTTP endpoint.',
    migrate_to: 'Use the V3 CLI: node scripts/ingest-pdf.mjs',
  });
}
