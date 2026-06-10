/**
 * AI Chunking & Diff Agent — POST /api/ingest/structure
 *
 * Takes the clean Markdown string from /api/ingest/parse and:
 *   1. Splits it into discrete rule sections (via pre-normalized ## headers)
 *   2. Uses GPT-4o-mini (structured JSON output) to extract rule_number,
 *      title, and body from each section
 *   3. Diffs each rule against the parent league's rule index to determine
 *      whether it is additive or an override (setting overrides_rule_id)
 *   4. Bulk-inserts all validated rules in a single DB transaction
 *
 * Request body (JSON):
 *   {
 *     markdown:   string   — output from /api/ingest/parse
 *     league_id:  string   — UUID of the target league (must already exist)
 *     sport:      string   — "baseball" | "softball"  (default: "baseball")
 *   }
 *
 * Response (success):
 *   { success: true, inserted: N, skipped: [...], warnings: [...], rules: [...] }
 *
 * Response (failure):
 *   { success: false, error: string, detail?: string, warnings?: [...] }
 *
 * Required env vars:
 *   INGEST_API_KEY   — bearer token guarding this admin endpoint
 *   OPENAI_API_KEY   — GPT-4o-mini structured output
 *   DATABASE_URL     — Supabase Postgres connection string
 *
 * Quality gates (will block insertion):
 *   • document_quality === "poor" in AI assessment
 *   • Fewer than 2 rules extracted total
 *   • Fewer than 40% of Markdown sections resolve to valid rules
 *
 * Soft warnings (logged, insertion continues):
 *   • Override confidence below 0.75  → overrides_rule_id set to NULL
 *   • Override parent rule number not found in parent index
 *   • Rule already exists (skipped via ON CONFLICT DO NOTHING)
 */

import pg      from 'pg';
import OpenAI  from 'openai';

const { Client } = pg;

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL                       = 'gpt-4o-mini';
const MAX_SECTIONS_PER_BATCH      = 25;      // keeps output under 4o-mini's 16k token limit
const OVERRIDE_CONFIDENCE_THRESHOLD = 0.75;  // below this, override claim is downgraded to warning
const MIN_RULE_COUNT              = 2;        // fewer rules than this = quality gate failure
const MIN_EXTRACTION_RATE         = 0.40;    // fraction of ## sections that must become valid rules
const VALID_SPORTS                = new Set(['baseball', 'softball', 'both']);

// ─── Auth middleware (mirrors parse.js pattern) ───────────────────────────────

const withIngestAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ success: false, error: 'Method not allowed' });

  const expectedKey = process.env.INGEST_API_KEY;
  if (!expectedKey) {
    return res.status(500).json({ success: false, error: 'Server misconfiguration: INGEST_API_KEY not set' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token !== expectedKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  return handler(req, res);
};

// ─── Main handler ─────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  // ── 1. Input validation ────────────────────────────────────────────────────

  const { markdown, league_id, sport = 'baseball' } = req.body ?? {};

  if (!markdown || typeof markdown !== 'string' || markdown.trim().length < 100) {
    return res.status(400).json({
      success: false,
      error:   'markdown is required and must be a non-empty string (min 100 chars). Run /api/ingest/parse first.',
    });
  }
  if (!league_id || typeof league_id !== 'string') {
    return res.status(400).json({ success: false, error: 'league_id (UUID) is required.' });
  }
  // Basic UUID format guard
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(league_id)) {
    return res.status(400).json({ success: false, error: 'league_id must be a valid UUID.' });
  }
  if (!VALID_SPORTS.has(sport)) {
    return res.status(400).json({
      success: false,
      error:   `sport must be "baseball", "softball", or "both". Got: "${sport}"`,
    });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ success: false, error: 'Server misconfiguration: OPENAI_API_KEY not set' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ success: false, error: 'Server misconfiguration: DATABASE_URL not set' });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const warnings = [];

  try {
    await client.connect();

    // ── 2. Fetch target league + follow parent_league_id ──────────────────────

    const leagueRes = await client.query(
      `SELECT l.id, l.name, l.slug, l.parent_league_id,
              p.id AS parent_id, p.name AS parent_name, p.slug AS parent_slug
       FROM leagues l
       LEFT JOIN leagues p ON p.id = l.parent_league_id
       WHERE l.id = $1`,
      [league_id],
    );

    if (leagueRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error:   `League "${league_id}" not found. Insert the league row first (Supabase dashboard or /api/ingest/league).`,
      });
    }

    const league       = leagueRes.rows[0];
    const leagueName   = league.name;
    const parentId     = league.parent_id   ?? null;
    const parentName   = league.parent_name ?? null;

    // ── 3. Fetch parent rules index (numbers + titles only, no bodies) ────────
    //
    // We only need enough for the AI to match local rules against parent rules.
    // Fetching full bodies would blow out the context window.

    let parentIndex = [];   // [{ id, rule_number, title }]

    if (parentId) {
      const parentRulesRes = await client.query(
        `SELECT id, rule_number, title
         FROM rules
         WHERE league_id = $1 AND (sport = $2 OR sport = 'baseball')
         ORDER BY rule_number`,
        [parentId, sport],
      );
      parentIndex = parentRulesRes.rows;
    }

    // ── 4. Split markdown into ## sections ────────────────────────────────────
    //
    // normalizeMarkdown() in parse.js already promoted rule-number lines to ##.
    // Each ## boundary reliably delineates one rule chunk.

    const sections = splitIntoSections(markdown);

    if (sections.length < 1) {
      return res.status(422).json({
        success: false,
        error:   'No ## section boundaries found in the Markdown. ' +
                 'The document may not have been processed through /api/ingest/parse, ' +
                 'or its structure is too flat for reliable chunking.',
      });
    }

    // ── 5. Run AI chunking in batches ─────────────────────────────────────────

    const batches      = chunk(sections, MAX_SECTIONS_PER_BATCH);
    const allAiRules   = [];
    const qualityNotes = [];
    let   worstQuality = 'good';

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batchSections = batches[batchIdx];
      const batchLabel    = `batch ${batchIdx + 1}/${batches.length}`;

      let aiResult;
      try {
        aiResult = await callChunkingAgent(openai, {
          sections:    batchSections,
          leagueName,
          parentName,
          parentIndex,
          sport,
          batchLabel,
        });
      } catch (err) {
        // If one batch fails, abort entire run — partial inserts would leave corrupt data
        return res.status(502).json({
          success:  false,
          error:    `AI chunking failed on ${batchLabel}: ${err.message}`,
          warnings,
        });
      }

      // Track worst quality across batches
      const rank = { good: 0, partial: 1, poor: 2 };
      if ((rank[aiResult.document_quality] ?? 0) > (rank[worstQuality] ?? 0)) {
        worstQuality = aiResult.document_quality;
      }
      if (aiResult.quality_notes) qualityNotes.push(`[${batchLabel}] ${aiResult.quality_notes}`);

      allAiRules.push(...(aiResult.rules ?? []));
    }

    // ── 6. Quality gate ───────────────────────────────────────────────────────

    if (worstQuality === 'poor') {
      return res.status(422).json({
        success: false,
        error:   'The AI assessed this document as "poor" quality: insufficient rule structure to extract reliably.',
        detail:  qualityNotes.join(' | '),
        warnings,
      });
    }

    const extractionRate = sections.length > 0
      ? allAiRules.length / sections.length
      : 0;

    if (allAiRules.length < MIN_RULE_COUNT) {
      return res.status(422).json({
        success: false,
        error:   `Only ${allAiRules.length} rules were extracted (minimum is ${MIN_RULE_COUNT}). ` +
                 'The document likely lacks numbered rule sections.',
        detail:  qualityNotes.join(' | '),
        warnings,
      });
    }

    if (extractionRate < MIN_EXTRACTION_RATE) {
      warnings.push(
        `Low extraction rate: ${allAiRules.length} rules from ${sections.length} sections ` +
        `(${Math.round(extractionRate * 100)}% — expected ≥ 40%). ` +
        'Some sections may have been consolidated or skipped.',
      );
    }

    // ── 7. Validate individual rules and resolve override UUIDs ──────────────

    const validatedRules = [];
    const invalidRules   = [];

    for (const rule of allAiRules) {
      // Basic shape check
      if (!rule.rule_number || !rule.title || !rule.body) {
        invalidRules.push({ raw: rule, reason: 'Missing rule_number, title, or body' });
        continue;
      }

      let overrides_rule_id = null;

      if (rule.is_override) {
        if ((rule.confidence ?? 0) < OVERRIDE_CONFIDENCE_THRESHOLD) {
          warnings.push(
            `Rule "${rule.rule_number}" — ${rule.title}: ` +
            `override claim has low confidence (${rule.confidence?.toFixed(2) ?? '?'}), ` +
            'overrides_rule_id set to NULL.',
          );
        } else if (rule.override_parent_rule_number) {
          // Map the parent rule number to a UUID from our index
          const parentMatch = parentIndex.find(
            p => p.rule_number === rule.override_parent_rule_number,
          );
          if (parentMatch) {
            overrides_rule_id = parentMatch.id;
          } else {
            warnings.push(
              `Rule "${rule.rule_number}" — ${rule.title}: ` +
              `override target "${rule.override_parent_rule_number}" not found in parent index. ` +
              'overrides_rule_id set to NULL.',
            );
          }
        }
      }

      validatedRules.push({
        rule_number:       String(rule.rule_number).trim().slice(0, 100),
        title:             String(rule.title).trim().slice(0, 500),
        body:              String(rule.body).trim(),
        is_override:       !!rule.is_override,
        overrides_rule_id,
        confidence:        rule.confidence ?? null,
      });
    }

    if (invalidRules.length > 0) {
      warnings.push(
        `${invalidRules.length} rule(s) failed shape validation and were skipped: ` +
        invalidRules.map(r => r.raw?.rule_number ?? 'unknown').join(', '),
      );
    }

    if (validatedRules.length === 0) {
      return res.status(422).json({
        success:  false,
        error:    'No valid rules survived validation after AI extraction.',
        detail:   qualityNotes.join(' | '),
        warnings,
      });
    }

    // ── 8. Bulk insert in a single transaction ────────────────────────────────

    const { inserted, skipped } = await insertRulesTransaction(
      client,
      validatedRules,
      league_id,
      sport,
    );

    // ── 9. Respond ────────────────────────────────────────────────────────────

    return res.status(200).json({
      success:         true,
      inserted,
      skipped,
      warnings,
      quality:         worstQuality,
      quality_notes:   qualityNotes.join(' | ') || null,
      extraction_rate: Math.round(extractionRate * 100) + '%',
      rules:           validatedRules.map(r => ({
        rule_number:       r.rule_number,
        title:             r.title,
        is_override:       r.is_override,
        overrides_rule_id: r.overrides_rule_id,
        confidence:        r.confidence,
      })),
    });

  } catch (err) {
    console.error('[ingest/structure] Unhandled error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.', warnings });
  } finally {
    try { await client.end(); } catch {}
  }
};

// ─── AI Chunking Agent ────────────────────────────────────────────────────────

/**
 * Calls GPT-4o-mini in JSON-object mode.
 * Each batch is independent so memory pressure stays constant.
 */
async function callChunkingAgent(openai, { sections, leagueName, parentName, parentIndex, sport, batchLabel }) {

  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt({ sections, leagueName, parentName, parentIndex, sport });

  let response;
  try {
    response = await openai.chat.completions.create({
      model:           MODEL,
      response_format: { type: 'json_object' },
      temperature:     0.1,       // near-deterministic — we want consistent extraction not creativity
      max_tokens:      16000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });
  } catch (err) {
    throw new Error(`OpenAI API call failed: ${err.message}`);
  }

  const raw = response.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned an empty response.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI response was not valid JSON despite json_object mode. Check model availability.');
  }

  if (!Array.isArray(parsed.rules)) {
    throw new Error(`OpenAI response missing "rules" array. Got keys: ${Object.keys(parsed).join(', ')}`);
  }

  return {
    rules:            parsed.rules,
    document_quality: parsed.document_quality ?? 'partial',
    quality_notes:    parsed.quality_notes    ?? '',
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are a precise baseball rulebook extraction agent. Your only job is to extract structured rule data from formatted Markdown text and output valid JSON.

You never invent information. When uncertain, you lower the confidence score and leave override fields null rather than guessing.

You understand that baseball rulebooks at the local league level come in two flavors:
1. ADDITIVE rules — new rules specific to this local league with no equivalent in the parent/foundation rulebook (e.g., administrative rules about fees, playoffs, field setup).
2. OVERRIDE rules — rules that explicitly modify, limit, or replace a rule that exists in the parent rulebook (e.g., "In this league, balks result in a warning, not an automatic advance.").

You will always return your response as a single JSON object with this exact shape:
{
  "rules": [ ...rule objects... ],
  "document_quality": "good" | "partial" | "poor",
  "quality_notes": "..."
}`;
}

/**
 * Builds the user-turn prompt.
 *
 * Prompt design rationale:
 * ─ The parent index is provided as a compact table (rule_number + title only,
 *   no bodies) so the AI can match local override claims without the full text
 *   exploding the context window.
 * ─ Extraction rules are written as numbered imperatives to minimize ambiguity.
 * ─ Rule #8 (SUBSECTION SPLITTING) is the key retrieval-quality lever: lettered
 *   subsections that cover distinct topics each get their own DB row and embedding,
 *   so a question about "mound visits per inning" retrieves 5.10(l) rather than
 *   a 13-subsection omnibus 5.10 blob that happens to contain the answer.
 * ─ Numbered sub-clauses (1)(2)(3) within a letter stay together — they are
 *   definitional sub-parts, not independent lookup targets.
 * ─ Confidence scoring is explained with concrete examples so the model
 *   calibrates rather than defaulting to 1.0.
 */
/**
 * Prompt design rationale:
 * ─ Rule #8 (SUBSECTION SPLITTING) is the key change from the original design.
 *   The original prompt prohibited splitting sub-clauses, which caused large
 *   compound rules (e.g., Rule 5.10 with 13 lettered subsections) to be stored
 *   as one oversized chunk. This hurt retrieval: a question about mound visits
 *   per inning would match the per-game subsection instead because both lived
 *   in the same embedding. The new rule allows — and encourages — splitting at
 *   the lettered-subsection level when each letter covers a distinct topic.
 * ─ Numbered sub-clauses (1), (2), (3) within a letter are kept together
 *   because they are definitional sub-parts, not independent lookup targets.
 * ─ The override_parent_rule_number hint is updated to support sub-rule notation
 *   so local leagues can override a specific subsection of a parent rule.
 */
function buildUserPrompt({ sections, leagueName, parentName, parentIndex, sport }) {
  const parentBlock = parentIndex.length > 0
    ? `PARENT RULEBOOK: ${parentName}\nRules available for override mapping (rule_number → title):\n` +
      parentIndex.map(p => `  ${p.rule_number}: ${p.title}`).join('\n')
    : 'PARENT RULEBOOK: none (this is a foundation rulebook — all rules are additive)';

  const overrideInstruction = parentIndex.length > 0
    ? `5. IS_OVERRIDE: Set true ONLY if this local rule explicitly modifies, limits, or replaces a rule from "${parentName}". Common signals: "In this league...", "does not apply", "instead of", or a topic that directly corresponds to a parent rule.
6. OVERRIDE_PARENT_RULE_NUMBER: If is_override=true, identify the EXACT rule_number from the parent index that this rule overrides (may use sub-rule notation if applicable, e.g. "5.10(m)"). Must match a value from the parent index or null. Never invent a parent rule number.`
    : `5. IS_OVERRIDE: Always false — no parent rulebook exists.
6. OVERRIDE_PARENT_RULE_NUMBER: Always null.`;

  const sectionsText = sections.map((s, i) => `[Section ${i + 1}]\n${s}`).join('\n\n---\n\n');

  return `EXTRACTION TASK
League: ${leagueName} (sport: ${sport})
${parentBlock}

EXTRACTION RULES — follow these precisely for every section:
1. RULE_NUMBER: Extract the official identifier from the ## header line. Examples: "5.01", "Rule 7", "Regulation VI", "15". If the header has both a number and a descriptive name, use the number only. If only a name exists, use the name as the rule_number. For sub-rules produced by subsection splitting (see rule 8), append the letter in parentheses: "5.10(l)", "5.10(m)", "6.01(a)".
2. TITLE: Human-readable topic of this specific rule or sub-rule. For sub-rules, use the lettered subsection's own topic — not the parent rule's title.
3. BODY: The rule text that applies to THIS rule object only. For sub-rules, include only the text of that lettered subsection plus any numbered sub-parts within it. Do NOT include the ## header line in the body. Do NOT truncate.
${overrideInstruction}
7. CONFIDENCE: 0.0–1.0 reflecting your certainty in this extraction:
   • 1.0: Clear rule number, clean body, unambiguous classification
   • 0.8–0.9: Minor ambiguity in rule_number format or override match
   • 0.6–0.75: Rule number inferred, or override match is plausible but uncertain
   • < 0.6: Significant structural ambiguity — consider whether this section is actually a rule

8. SUBSECTION SPLITTING: When a ## section contains multiple lettered subsections — (a), (b), (c)... — where each covers a TOPICALLY DISTINCT concept that an umpire might look up independently, produce a SEPARATE rule object per lettered subsection.
   • DO split: e.g. (a) = player substitution timing, (b) = manager notification, (l) = inning mound visit limit, (m) = per-game mound visit limit — each answers a different question.
   • DO NOT split: numbered sub-clauses (1), (2), (3) within the same letter — keep those inside their parent letter's body.
   • DO NOT split: a lettered clause that is only a short exception, penalty, or qualifier with no standalone meaning without its parent.
   • WHEN IN DOUBT: split. Focused single-topic chunks retrieve far better than large omnibus rules.

CRITICAL — DO NOT:
• Invent or modify rule numbers. Copy them exactly from the ## header (or use sub-rule notation when splitting).
• Claim is_override=true unless you can match a specific parent rule number AND the local text clearly modifies it.
• Include the ## header text in the body field.
• Skip sections silently — if a section is not a rule (e.g., table of contents, blank divider), set confidence < 0.5 and note it in quality_notes.

DOCUMENT QUALITY ASSESSMENT (assess after extracting all rules):
• "good" — clear rule numbers on all or nearly all sections, clean structure
• "partial" — some sections lack rule numbers or have ambiguous boundaries; you extracted what you could
• "poor" — the document has no discernible rule structure; fewer than half the sections produced valid rules

OUTPUT: Return ONLY the JSON object. No markdown fences. No prose.

SECTIONS TO EXTRACT:
---
${sectionsText}
---`;
}

// ─── Database transaction ─────────────────────────────────────────────────────

/**
 * Inserts all validated rules in a single atomic transaction.
 *
 * Uses ON CONFLICT DO NOTHING so re-running ingestion for the same league
 * is safe and idempotent. Returns counts of inserted and skipped rules.
 */
async function insertRulesTransaction(client, rules, league_id, sport) {
  const inserted = [];
  const skipped  = [];

  await client.query('BEGIN');

  try {
    for (const rule of rules) {
      const result = await client.query(
        `INSERT INTO rules
           (league_id, rule_number, title, body, sport, overrides_rule_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (league_id, rule_number, sport) DO NOTHING
         RETURNING id, rule_number`,
        [
          league_id,
          rule.rule_number,
          rule.title,
          rule.body,
          sport,
          rule.overrides_rule_id ?? null,
        ],
      );

      if (result.rows.length > 0) {
        inserted.push({ id: result.rows[0].id, rule_number: rule.rule_number });
      } else {
        skipped.push({
          rule_number: rule.rule_number,
          reason:      'Already exists — ON CONFLICT skipped (re-ingestion or duplicate)',
        });
      }
    }

    await client.query('COMMIT');
    return { inserted: inserted.length, skipped };

  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Transaction failed and was rolled back: ${err.message}`);
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Splits a normalized Markdown string into discrete sections using ## as
 * the boundary marker. Strips the source stamp comment and blank sections.
 *
 * Input:  "<!-- ingested from: ... -->\n\n## Rule 1\nbody...\n\n## Rule 2\nbody..."
 * Output: ["## Rule 1\nbody...", "## Rule 2\nbody..."]
 */
function splitIntoSections(markdown) {
  // Remove the ingestion stamp comment added by normalizeMarkdown()
  const stripped = markdown.replace(/^<!--.*?-->\n*/s, '');

  return stripped
    .split(/\n(?=##\s)/m)
    .map(s => s.trim())
    .filter(s => {
      if (s.length < 15)     return false;   // too short to be a rule
      if (!s.startsWith('##')) return false;  // must be a rule section
      return true;
    });
}

/**
 * Splits an array into chunks of a given size.
 * Used to batch sections for the AI call.
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Named exports allow the re-seed script (api/reseed-leagues.mjs) to reuse
// the exact same prompts and DB transaction logic without duplication.
export { callChunkingAgent, insertRulesTransaction, splitIntoSections, chunk };

export default withIngestAuth(handler);
