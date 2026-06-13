import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = await fs.readFile(path.join(ROOT, '.env.local'), 'utf-8');
for (const line of raw.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const key = t.slice(0, eq).trim();
  const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  if (!process.env[key]) process.env[key] = val;
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// 1. Rule + embedding counts per league
const counts = await db.query(`
  SELECT l.slug, l.name, COUNT(DISTINCT r.id) as rules, COUNT(DISTINCT re.id) as embeddings
  FROM leagues l
  LEFT JOIN rules r ON r.league_id = l.id
  LEFT JOIN rule_embeddings re ON re.rule_id = r.id
  GROUP BY l.slug, l.name ORDER BY l.name
`);
console.log('League counts:');
counts.rows.forEach(r => console.log(` ${r.slug.padEnd(20)} ${r.rules} rules  ${r.embeddings} embeddings`));

// 2. BAMSBL rules mentioning slide
const slide = await db.query(`
  SELECT r.rule_number, r.title, r.body
  FROM rules r
  JOIN leagues l ON l.id = r.league_id
  WHERE l.slug = 'bamsbl'
    AND (lower(r.title) LIKE '%slide%' OR lower(r.body) LIKE '%slide%' OR lower(r.title) LIKE '%must%')
`);
console.log('\nBAMSBL rules mentioning slide/must:');
if (slide.rows.length === 0) {
  console.log('  (none found)');
} else {
  slide.rows.forEach(r => console.log(`  [${r.rule_number}] ${r.title}\n   ${r.body.slice(0, 200)}\n`));
}

// 3. Check vector search score for "must slide" against bamsbl
const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'text-embedding-3-small', input: 'must slide rule' }),
});
const { data } = await embedRes.json();
const vec = `[${data[0].embedding.join(',')}]`;

const search = await db.query(`
  SELECT r.rule_number, r.title, (re.embedding <=> $2::vector) AS distance
  FROM rule_embeddings re
  JOIN rules r ON r.id = re.rule_id
  JOIN leagues l ON l.id = r.league_id
  WHERE l.slug = $1 AND re.model = 'text-embedding-3-small'
  ORDER BY distance LIMIT 5
`, ['bamsbl', vec]);
console.log('\nVector search top 5 for "must slide rule" in BAMSBL:');
if (search.rows.length === 0) {
  console.log('  (no results — embeddings missing?)');
} else {
  search.rows.forEach(r => console.log(`  dist=${parseFloat(r.distance).toFixed(4)}  [${r.rule_number}] ${r.title}`));
}

await db.end();
