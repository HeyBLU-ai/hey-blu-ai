/**
 * scripts/triage-anomalies.mjs
 *
 * One-off: fetch anomalous BAMSBL rule atoms (empty, '-', or '3' rule_number)
 * from the active version and ask Claude to rank the Top 10 most critical
 * in-game rules that need a proper citation number.
 *
 * Usage: node scripts/triage-anomalies.mjs
 */

import pg         from 'pg';
import Anthropic  from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ── Load .env.local ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(resolve(__dirname, '../.env.local'), 'utf8').split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on environment */ }

// ── DB: fetch anomalous rules ─────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

console.log('Querying anomalous rules for active BAMSBL version…\n');

const { rows } = await pool.query(`
  SELECT r.id, r.rule_number, r.title, r.body
  FROM   rules r
  JOIN   rulebook_versions rv ON rv.id = r.rulebook_version_id
  JOIN   leagues l ON l.id = rv.league_id
  WHERE  l.slug   = 'bamsbl'
    AND  rv.status = 'active'
    AND  (
      r.rule_number IS NULL
      OR TRIM(r.rule_number) = ''
      OR TRIM(r.rule_number) = '-'
      OR TRIM(r.rule_number) = '3'
    )
  ORDER BY r.title
`);

await pool.end();

console.log(`Found ${rows.length} anomalous atoms.\n`);

if (rows.length === 0) {
  console.log('Nothing to triage — all rules are numbered.');
  process.exit(0);
}

// ── Format numbered list ──────────────────────────────────────────────────────

const list = rows.map((r, i) => {
  const snippet = (r.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return `${i + 1}. [${r.id}] - ${r.title ?? '(no title)'}: ${snippet}`;
}).join('\n\n');

// ── Ask Claude ────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are an expert baseball umpire.`;

const USER = `Below is a list of rulebook paragraphs where the ingestion engine failed to find the parent rule number.

Read the list and identify the Top 10 most critical IN-GAME rules (e.g., collisions, sliding, interference, appeals, ejections). Ignore administrative rules (e.g., fees, jersey requirements, trading deadlines).

Return a clean, numbered list of the Top 10 rules. For each, include the [Row ID], a brief snippet of the text, and a 1-sentence reason why it is a high-priority in-game rule that an umpire or coach would need a citation for.

---
${list}`;

console.log('Sending to Claude… (this may take a few seconds)\n');
console.log('─'.repeat(60));

const message = await anthropic.messages.create({
  model:      process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6',
  max_tokens: 2048,
  system:     SYSTEM,
  messages:   [{ role: 'user', content: USER }],
});

const reply = message.content[0]?.text ?? '(no response)';
console.log(reply);
console.log('\n' + '─'.repeat(60));
console.log(`\nDone. Stop tokens: ${message.usage?.output_tokens ?? '?'}`);
