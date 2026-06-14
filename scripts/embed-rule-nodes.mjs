/**
 * scripts/embed-rule-nodes.mjs
 *
 * Generate OpenAI embeddings for rule_node_chunks missing vectors.
 *
 * Usage:
 *   node scripts/embed-rule-nodes.mjs
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
  } catch { /* ignore */ }
}

loadLocalEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error('[rule-nodes] OPENAI_API_KEY not configured.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

function vectorLiteral(values) {
  return `[${values.map(v => Number.isFinite(v) ? v : 0).join(',')}]`;
}

function embeddingInput(row) {
  return [
    row.rule_number ? `Rule ${row.rule_number}` : null,
    row.title ? `Title: ${row.title}` : null,
    row.chunk_text,
  ].filter(Boolean).join('\n');
}

async function main() {
  const { rows: chunks } = await pool.query(`
    SELECT
      c.id,
      c.chunk_text,
      n.rule_number,
      n.title
    FROM rule_node_chunks c
    JOIN rule_nodes n ON n.id = c.rule_node_id
    WHERE c.embedding IS NULL
    ORDER BY n.rule_number NULLS LAST, c.chunk_index
  `);

  console.log(`[rule-nodes] embedding_model=${MODEL}`);
  console.log(`[rule-nodes] pending=${chunks.length}`);

  let embedded = 0;
  for (const chunk of chunks) {
    const input = embeddingInput(chunk);
    const result = await openai.embeddings.create({
      model: MODEL,
      input,
      dimensions: 1536,
    });
    const embedding = result.data[0]?.embedding;
    if (!embedding || embedding.length !== 1536) {
      throw new Error(`Invalid embedding length for chunk ${chunk.id}`);
    }
    await pool.query(
      `UPDATE rule_node_chunks SET embedding = $1::vector WHERE id = $2`,
      [vectorLiteral(embedding), chunk.id],
    );
    embedded += 1;
    console.log(`[rule-nodes] embedded ${embedded}/${chunks.length} chunk=${chunk.id.slice(0, 8)}… rule=${chunk.rule_number ?? '(none)'}`);
  }

  const { rows: [summary] } = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
    FROM rule_node_chunks
  `);
  console.log(`[rule-nodes] done total=${summary.total} embedded=${summary.embedded}`);
  await pool.end();
}

main().catch(async err => {
  console.error('[rule-nodes] embedding failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
