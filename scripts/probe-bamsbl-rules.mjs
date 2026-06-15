#!/usr/bin/env node
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transformPdfToBlocks } from '../lib/ingest/adapters/pdf-parse-blocks.js';
import { canonicalizeBlocks } from '../lib/ingest/canonicalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
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
}

async function probeDb(vidFromPdf) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: ver } = await pool.query(`
    SELECT rv.id, rv.season, rv.status, rv.created_at
    FROM rulebook_versions rv
    JOIN leagues l ON l.id = rv.league_id
    WHERE l.slug = 'bamsbl' AND rv.status = 'active'
    ORDER BY rv.created_at DESC LIMIT 1
  `);
  console.log('\n=== Active BAMSBL version ===');
  console.log(ver[0]);

  const vid = ver[0]?.id;
  const { rows: rules } = await pool.query(`
    SELECT rule_number, node_type, MIN(title) AS title
    FROM rule_nodes
    WHERE rulebook_version_id = $1 AND rule_number IS NOT NULL
    GROUP BY rule_number, node_type
    ORDER BY MIN(sort_order)
  `, [vid]);
  console.log(`\nDistinct rule_numbers in DB (${rules.length}):`);
  for (const r of rules) console.log(`  ${r.rule_number} [${r.node_type}] ${(r.title || '').slice(0, 70)}`);

  const { rows: check } = await pool.query(`
    SELECT rule_number, title, length(body_text) AS body_len
    FROM rule_nodes
    WHERE rulebook_version_id = $1 AND rule_number IN ('300','305','310','420')
    ORDER BY rule_number
  `, [vid]);
  console.log('\nDB check for 300/305/310/420:');
  if (!check.length) console.log('  (none found)');
  for (const r of check) console.log(`  ${r.rule_number}: body=${r.body_len} — ${r.title}`);

  await pool.end();
}

async function probePdf() {
  const pdfPath = resolve(__dirname, '../rulebooks/2026bamsblrules-14-25.pdf');
  const buf = readFileSync(pdfPath);
  const result = await transformPdfToBlocks(buf, {
    rulebookId: 'probe',
    ruleDocumentId: 'probe',
    filename: '2026bamsblrules-14-25.pdf',
  });

  console.log('\n=== PDF extraction ===');
  console.log(`Pages: ${result.pages.length}, Blocks: ${result.metadata.blockCount}`);

  const page1 = result.pages[0];
  console.log('\nPage 1 blocks (first 8):');
  for (const b of (page1?.blocks ?? []).slice(0, 8)) {
    const preview = b.exactText.replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  [${b.blockType}/${b.styleMetadata?.role}] ${preview}`);
  }

  const blocks = result.pages.flatMap((p) =>
    p.blocks.map((b, i) => ({
      id: `b-${p.pageNumber}-${i}`,
      extraction_run_id: 'probe',
      source_page_id: `p-${p.pageNumber}`,
      block_index: b.blockIndex ?? i,
      block_type: b.blockType,
      char_offset_start: b.charOffsetStart,
      char_offset_end: b.charOffsetEnd,
      bbox: b.bbox,
      exact_text: b.exactText,
      style_metadata: b.styleMetadata ?? {},
      page_number: p.pageNumber,
      read_y: b.bbox?.y ?? 0,
    })),
  );

  const { nodes, warnings } = canonicalizeBlocks(blocks);
  const numbered = nodes.filter((n) => n.rule_number);
  const uniqueRules = [...new Set(numbered.map((n) => n.rule_number))].sort((a, b) => Number(a) - Number(b));
  console.log(`\nCanonicalizer output: ${nodes.length} nodes, ${uniqueRules.length} unique rule numbers`);
  console.log('First 10 rule numbers:', uniqueRules.slice(0, 10).join(', '));
  console.log('Last 5 rule numbers:', uniqueRules.slice(-5).join(', '));

  const r300 = nodes.filter((n) => ['300', '305', '310'].includes(n.rule_number));
  console.log('\nCanonical nodes for 300/305/310:');
  if (!r300.length) console.log('  (none — likely swallowed by isTocHeading on pages 1–3)');
  for (const n of r300) {
    console.log(`  ${n.rule_number} [${n.node_type}] "${n.title}" body=${n.body_text.length}ch`);
  }

  console.log(`Orphan body warnings: ${warnings.filter((w) => w.warning_code === 'ORPHAN_BODY').length}`);

  const page420 = blocks.find((b) => /^420\./.test(b.exact_text.trim()));
  console.log(`Rule 420 first appears on page: ${page420?.page_number ?? 'not found'}`);
}

loadEnv();
await probePdf();
if (process.env.DATABASE_URL) {
  await probeDb();
}
