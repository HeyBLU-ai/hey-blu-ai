import pg from 'pg';
import { config } from 'dotenv';
config({ path: '.env.local' });

// Exact copy of normalizeQuestion from api/ask-v2.js — must stay in sync.
function normalizeQuestion(q) {
  if (!q || typeof q !== 'string') return '';
  return q
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]{}/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const raw = process.argv[2];

if (!raw) {
  console.error('Usage: node scripts/evict-cache.mjs "<search term>"');
  process.exit(1);
}

const normalized = normalizeQuestion(raw);

console.log(`\nEvicting cache entry for normalized question:`);
console.log(`  raw       : "${raw}"`);
console.log(`  normalized: "${normalized}"`);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(
  'DELETE FROM verified_answer_cache WHERE normalized_question = $1 RETURNING id',
  [normalized],
);

if (rows.length === 0) {
  console.log('\n  No matching cache entry found — nothing deleted.');
} else {
  console.log(`\n  ✓ Deleted ${rows.length} row(s):`);
  rows.forEach(r => console.log(`    ${r.id}`));
}

await pool.end();
