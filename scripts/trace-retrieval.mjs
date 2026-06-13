/**
 * scripts/trace-retrieval.mjs
 *
 * Full pipeline trace for a hardcoded question.
 * Replicates fetchSourceSpans + verifier exactly as ask-v2.js does,
 * logging every intermediate step so we can pinpoint the failure.
 *
 * Usage: node scripts/trace-retrieval.mjs
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
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* rely on env */ }

// ── Config ────────────────────────────────────────────────────────────────────
const QUESTION    = 'What are the requirements for player jerseys and caps?';
const LEAGUE_SLUG = 'bamsbl';
const LINE        = '─'.repeat(70);

const FTS_STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','dare','ought','used',
  'i','me','my','we','our','you','your','he','his','she','her','it','its',
  'they','their','them','this','that','these','those','who','which','what',
  'when','where','why','how','and','but','or','nor','for','yet','so',
  'in','on','at','to','of','by','from','up','about','into','through',
  'there','here','not','no','if','then','than','as','with','any','all',
]);

function buildOrFallbackQuery(q) {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !FTS_STOP_WORDS.has(w));
  return [...new Set(words)].join(' | ');
}

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db   = await pool.connect();

console.log(LINE);
console.log('TRACE: ' + QUESTION);
console.log(LINE);

// Step 0: active version
const { rows: [ver] } = await db.query(`
  SELECT rv.id, rv.status
  FROM rulebook_versions rv
  JOIN leagues l ON l.id = rv.league_id
  WHERE l.slug = $1 AND rv.status = 'active'
`, [LEAGUE_SLUG]);
if (!ver) { console.error('No active version!'); process.exit(1); }
console.log(`\n[STEP 0] Active version: ${ver.id}`);

const VID = ver.id;

// ── Step 1: Pass 1 FTS (AND) ──────────────────────────────────────────────────
const SPAN_COLS = `
  SELECT
    rs.id AS source_id, rs.exact_text, rs.page_start, rs.section_path,
    string_agg(r.rule_number, ',' ORDER BY r.rule_number) AS rule_numbers
  FROM rule_sources rs
  JOIN rule_documents rd ON rd.id = rs.document_id
  JOIN rule_source_links rsl ON rsl.source_id = rs.id
  JOIN rules r ON r.id = rsl.rule_id
  WHERE rd.version_id = $2 AND r.rulebook_version_id = $2
`;

// Show what plainto_tsquery expands to
const { rows: [tsqRow] } = await db.query(
  `SELECT plainto_tsquery('english', $1)::text AS tsq`, [QUESTION],
);
console.log(`\n[STEP 1] Pass 1 — plainto_tsquery (AND) expansion:`);
console.log(`  Input : "${QUESTION}"`);
console.log(`  TSQuery: ${tsqRow.tsq}`);

let pass1Rows = [];
try {
  const { rows } = await db.query(`
    ${SPAN_COLS}
      AND to_tsvector('english', rs.exact_text) @@ plainto_tsquery('english', $1)
    GROUP BY rs.id, rs.exact_text, rs.page_start, rs.section_path
    ORDER BY ts_rank(to_tsvector('english', rs.exact_text), plainto_tsquery('english', $1)) DESC
    LIMIT 8
  `, [QUESTION, VID]);
  pass1Rows = rows;
} catch (e) {
  console.log(`  !! Pass 1 SQL ERROR: ${e.message}`);
}
console.log(`  Result: ${pass1Rows.length} span(s)`);
if (pass1Rows.length > 0) {
  pass1Rows.forEach((r, i) => console.log(`    [${i+1}] rules=${r.rule_numbers || '(none)'} | ${r.exact_text.slice(0,100).replace(/\n/g,' ')}`));
}

// ── Step 2: Pass 2 FTS (OR) ───────────────────────────────────────────────────
const orTerms = buildOrFallbackQuery(QUESTION);
console.log(`\n[STEP 2] Pass 2 — OR-fallback keyword extraction:`);
console.log(`  OR terms string : "${orTerms}"`);

let pass2Rows = [];
if (pass1Rows.length === 0) {
  // Show what to_tsquery expands the OR terms to
  try {
    const { rows: [orTsqRow] } = await db.query(
      `SELECT to_tsquery('english', $1)::text AS tsq`, [orTerms],
    );
    console.log(`  to_tsquery result: ${orTsqRow.tsq}`);
  } catch (e) {
    console.log(`  !! to_tsquery expansion ERROR: ${e.message}`);
  }

  try {
    const { rows } = await db.query(`
      ${SPAN_COLS}
        AND to_tsvector('english', rs.exact_text) @@ to_tsquery('english', $1)
      GROUP BY rs.id, rs.exact_text, rs.page_start, rs.section_path
      ORDER BY ts_rank(to_tsvector('english', rs.exact_text), to_tsquery('english', $1)) DESC
      LIMIT 8
    `, [orTerms, VID]);
    pass2Rows = rows;
  } catch (e) {
    console.log(`  !! Pass 2 SQL ERROR: ${e.message}`);
  }
  console.log(`  Result: ${pass2Rows.length} span(s)`);
  if (pass2Rows.length > 0) {
    pass2Rows.forEach((r, i) => console.log(`    [${i+1}] rules=${r.rule_numbers || '(none)'} | ${r.exact_text.slice(0,100).replace(/\n/g,' ')}`));
  }
} else {
  console.log('  (skipped — Pass 1 succeeded)');
}

// ── Step 3: Full exact_text of retrieved spans ────────────────────────────────
const spans = pass1Rows.length > 0 ? pass1Rows : pass2Rows;
console.log(`\n[STEP 3] EXACT exact_text of ${spans.length} retrieved span(s):`);
if (spans.length === 0) {
  console.log('  !! ZERO SPANS — model will say "no rule found". Pipeline ends here.');
} else {
  spans.forEach((s, i) => {
    console.log(`\n  ── Span ${i+1} [${s.source_id}] rule_numbers=${s.rule_numbers || '(none)'} ──`);
    console.log(s.exact_text);
  });
}

if (spans.length === 0) {
  db.release(); await pool.end();
  console.log('\n' + LINE);
  console.log('DIAGNOSIS: Retrieval returns 0 spans. Nothing to send to verifier.');
  console.log(LINE);
  process.exit(0);
}

// ── Step 4: Build draft prompt (matches ask-v2 buildSpanPrompt) ───────────────
const excerptBlock = spans.map((s, i) => {
  const ruleRef  = (s.rule_numbers ?? '').replace(/,/g, ' /').trim() || 'Unnumbered';
  const pageNote = s.page_start != null ? ` — p.${s.page_start}` : '';
  return `[Source ${i+1}] Rule ${ruleRef}${pageNote}:\n"${s.exact_text}"`;
}).join('\n\n');

const draftPrompt = `You are an expert baseball rules official for the BAMSBL.

Your job: answer the umpire's question using ONLY the verbatim source excerpts from the official rulebook shown below.

RULEBOOK SOURCE EXCERPTS (${spans.length} retrieved):
${excerptBlock}

QUESTION: ${QUESTION}

Instructions:
- Answer ONLY from the source excerpts above. Do NOT cite, invent, or infer rules that do not appear in the excerpts.
- If no excerpt covers the question, respond with exactly: "I could not find a specific rule about this in the loaded rulebook."
- Otherwise, structure your response in EXACTLY these two parts, in this order, with these exact headings:

**The Ruling:** Write a conversational, plain-English explanation that an umpire can understand and act on immediately.

**The Book:** Provide the official citation(s) using these exact formats:
- If the source excerpt has a clear rule number (e.g. "305"): **Official Rule [Number]:** "[Exact verbatim quote from the source excerpt]"`;

console.log(`\n[STEP 4] Draft prompt sent to Sonnet (${draftPrompt.length} chars):`);
console.log(LINE);
console.log(draftPrompt);
console.log(LINE);

// ── Step 5: Call Sonnet for draft ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

console.log('\n[STEP 5] Calling draft model (Sonnet)…');
const draftMsg = await anthropic.messages.create({
  model:      process.env.ANTHROPIC_ANSWER_MODEL ?? 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages:   [{ role: 'user', content: draftPrompt }],
});
const draftAnswer = draftMsg.content[0]?.text?.trim() ?? '';
console.log('\n  DRAFT ANSWER:');
console.log(LINE);
console.log(draftAnswer);
console.log(LINE);

// ── Step 6: Build verifier prompt ─────────────────────────────────────────────
const VERIFIER_SYSTEM = `You are a strict fact-checking verifier for a baseball rules Q&A system.

You will receive:
1. A DRAFT ANSWER produced by an AI assistant.
2. ALLOWED SOURCE EXCERPTS — verbatim passages from the official rulebook.

Your task: for every factual claim in the draft answer, determine whether it is
directly and explicitly stated in the provided source excerpts.

CRITICAL RULES:
- Use ONLY the provided source excerpts. Do NOT draw on your own baseball knowledge.
- A claim is "supported" only if a source excerpt explicitly states the same fact.
- Reasonable inferences and implications do NOT count as supported.
- If the draft correctly says "I could not find a specific rule about this", return status "no_rule_found".

PARTIAL OR INCOMPLETE SOURCE TEXT:
- If the source text partially addresses the question (e.g., acknowledges a rule or category
  exists but does not list every sub-bullet or detail), do NOT mark the answer "unsupported".
- If every claim the draft actually makes is backed by the source text, return "approved" —
  even if the answer is incomplete relative to the full rule.
- If the draft is correct but explicitly notes that details are missing or that the full rule
  could not be found in the retrieved text, return "needs_fact".
- Reserve "unsupported" ONLY for answers that assert or invent facts that are NOT present
  anywhere in the provided source excerpts, or that directly contradict the sources.

Return ONLY valid JSON — no preamble, no markdown:
{
  "status": "approved" | "unsupported" | "needs_fact" | "no_rule_found",
  "claims": [{ "claim": "...", "supported": true|false, "source_ids": ["..."] }],
  "unsupported_claims": ["..."],
  "confidence": "high" | "medium" | "low"
}`;

const sourceBlock = spans
  .map(s => {
    const ruleRef = (s.rule_numbers ?? '').replace(/,/g, ' /').trim() || 'Unnumbered';
    return `[Source ${s.source_id}]\nRule ${ruleRef}:\n"${s.exact_text}"`;
  })
  .join('\n\n');

const verifierUserMsg = `DRAFT ANSWER TO VERIFY:
${draftAnswer}

ALLOWED SOURCE EXCERPTS:
${sourceBlock}

Verify every factual claim in the draft answer against the source excerpts above.
Return JSON only.`;

console.log(`\n[STEP 6] Verifier prompt sent to Opus (${verifierUserMsg.length} chars):`);
console.log(LINE);
console.log(verifierUserMsg);
console.log(LINE);

// ── Step 7: Call Opus verifier ────────────────────────────────────────────────
console.log('\n[STEP 7] Calling verifier model (Opus)…');
const verifyMsg = await anthropic.messages.create({
  model:      process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-opus-4-8',
  max_tokens: 1024,
  system:     VERIFIER_SYSTEM,
  messages:   [{ role: 'user', content: verifierUserMsg }],
});
const verifyRaw = verifyMsg.content[0]?.text?.trim() ?? '';
console.log('\n  VERIFIER RAW RESPONSE:');
console.log(LINE);
console.log(verifyRaw);
console.log(LINE);

// Parse
let verifierAudit = null;
try {
  const start = verifyRaw.indexOf('{');
  const end   = verifyRaw.lastIndexOf('}');
  verifierAudit = JSON.parse(verifyRaw.slice(start, end + 1));
} catch (e) {
  console.log('  !! JSON parse error:', e.message);
}

const isBlocked = verifierAudit
  ? (verifierAudit.status === 'unsupported' || (verifierAudit.unsupported_claims?.length ?? 0) > 0)
  : true;

console.log(`\n[STEP 8] GATE RESULT:`);
console.log(`  verifier_status  : ${verifierAudit?.status ?? 'PARSE_ERROR'}`);
console.log(`  unsupported_claims: ${JSON.stringify(verifierAudit?.unsupported_claims ?? [])}`);
console.log(`  BLOCKED          : ${isBlocked}`);
console.log(`  USER WOULD SEE   : ${isBlocked ? '❌ blocked — unverifiable' : '✅ passes — answer delivered'}`);

db.release();
await pool.end();
console.log('\n' + LINE + '\nTrace complete.\n');
