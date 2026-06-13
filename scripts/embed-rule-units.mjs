/**
 * Generate OpenAI embeddings for canonical rule_units.
 *
 * Usage:
 *   node scripts/embed-rule-units.mjs
 */

import pg from 'pg';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  try {
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
  } catch {
    // Runtime env may already be populated.
  }
}

loadLocalEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error('[rule-units] OPENAI_API_KEY not configured; cannot embed rule_units.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

function vectorLiteral(values) {
  return `[${values.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

function embeddingInput(unit) {
  return [
    `Rule ${unit.rule_number}`,
    unit.title ? `Title: ${unit.title}` : null,
    unit.full_text,
  ].filter(Boolean).join('\n');
}

async function main() {
  const { rows: units } = await pool.query(`
    SELECT id, rule_number, title, full_text
    FROM rule_units
    WHERE league_slug = 'bamsbl'
      AND embedding IS NULL
    ORDER BY rule_number
  `);

  console.log(`[rule-units] embedding_model=${MODEL}`);
  console.log(`[rule-units] pending=${units.length}`);

  let embedded = 0;
  for (const unit of units) {
    const input = embeddingInput(unit);
    const result = await openai.embeddings.create({
      model: MODEL,
      input,
      dimensions: 1536,
    });
    const embedding = result.data[0]?.embedding;
    if (!embedding || embedding.length !== 1536) {
      throw new Error(`Embedding for Rule ${unit.rule_number} had invalid length ${embedding?.length}`);
    }
    await pool.query(
      `UPDATE rule_units SET embedding = $1::vector, updated_at = now() WHERE id = $2`,
      [vectorLiteral(embedding), unit.id],
    );
    embedded += 1;
    console.log(`[rule-units] embedded ${embedded}/${units.length} rule=${unit.rule_number}`);
  }

  const { rows: [summary] } = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
    FROM rule_units
    WHERE league_slug = 'bamsbl'
  `);
  console.log(`[rule-units] done total=${summary.total} embedded=${summary.embedded}`);
  await pool.end();
}

main().catch(async err => {
  console.error('[rule-units] embedding failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
