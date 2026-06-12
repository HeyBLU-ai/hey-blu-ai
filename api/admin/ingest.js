/**
 * POST /api/admin/ingest
 *
 * Streaming SSE endpoint that runs the full ingest pipeline and
 * pushes live progress events back to the admin dashboard.
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 *
 * Request body (JSON):
 * {
 *   url?:            string   — public URL (HTML page or PDF link)
 *   fileBase64?:     string   — base64-encoded .pdf or .docx
 *   fileName?:       string   — original filename (required with fileBase64)
 *   leagueSlug?:     string   — existing league slug
 *   newLeagueName?:  string   — display name for a brand-new league
 *   newLeagueSlug?:  string   — DB slug for the new league (kebab-case)
 *   parentSlug?:     string   — parent league slug (for hierarchy + override detection)
 *   sport?:          string   — "baseball" | "softball" | "both"  (default: "baseball")
 *   replace?:        boolean  — delete existing rules before inserting
 *   dryRun?:         boolean  — parse + chunk but skip DB writes
 * }
 *
 * PDF path:  Upload to OpenAI Files API → GPT-4o reads doc natively → rules JSON
 * URL path:  Jina Reader → markdown → section split → callChunkingAgent
 * DOCX path: mammoth → markdown → section split → callChunkingAgent
 */

export const maxDuration = 300; // Vercel Pro: override 15s default to 5 minutes

import pg from 'pg';
import {
  callChunkingAgent,
  insertRulesTransaction,
  splitIntoSections,
  chunk,
} from '../ingest/structure.js';

const { Client } = pg;

const EMBED_MODEL = 'text-embedding-3-small';
const JINA_BASE   = 'https://r.jina.ai/';
const BATCH_SIZE  = 25;
const EMBED_BATCH = 50;
const DELAY_MS    = 300;
const OAI_BASE    = 'https://api.openai.com/v1';

// ── Auth middleware ───────────────────────────────────────────────────────────

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return handler(req, res);
};

// ── DB helper ─────────────────────────────────────────────────────────────────

async function withDb(fn) {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try   { return await fn(c); }
  finally { try { await c.end(); } catch {} }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (step, status, message, data = {}) =>
    res.write(`data: ${JSON.stringify({ step, status, message, ...data })}\n\n`);
  return { emit, done: () => res.end() };
}

// ── Markdown normalization (for URL / DOCX paths) ─────────────────────────────

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
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n\n')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/?[ou]l[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Claude PDF extraction ─────────────────────────────────────────────────────
// Sends the base64 PDF directly to Claude via the Anthropic messages API.
// No file upload step — Claude accepts PDFs inline as base64 document blocks.
// Returns the same shape as callChunkingAgent for compatibility.

function buildExtractionPrompt(leagueName, parentName, sport) {
  return `You are extracting the complete rulebook for "${leagueName}" (sport: ${sport}).
${parentName ? `This league is based on "${parentName}" rules and may contain local overrides or additions.` : ''}

Read this PDF carefully. For EVERY rule, regulation, and local modification in the document, extract:

- rule_number: The official identifier (e.g. "1.01", "Rule 5", "Section 3", "MUST-SLIDE"). Use the document's own numbering. If a rule has no number, create a short slug.
- title: 3–8 word descriptive title capturing the rule's topic.
- body: Concise 40–100 word summary. Capture every key fact, number, distance, count, and exception. Do NOT copy verbatim — write a clear, searchable summary an umpire could look up.
- is_override: true ONLY if this rule explicitly modifies a rule from the parent rulebook (${parentName ?? 'MLB OBR'}). Local additions are NOT overrides.
- override_parent_rule_number: Parent rule number being modified, or null.
- confidence: "high" if rule boundary is clear, "medium" if uncertain, "low" if guessing.

IMPORTANT:
- Extract EVERY rule — do not skip minor ones.
- Split lettered sub-sections (a), (b), (c) into separate objects when each covers a distinct independently-searchable topic.
- Skip table of contents, page headers/footers, and administrative preamble.

document_quality: "good" if document is clean and complete, "partial" if some rules were unclear, "poor" if document was mostly unreadable.
notes: Brief summary of any issues encountered.

Return your entire response as a single JSON object matching this structure:
{"rules": [...], "document_quality": "good|partial|poor", "notes": "..."}`;

}

async function extractRulesWithClaude({ fileBase64, leagueName, parentName, sport, emit, keepAlive }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  emit('parse', 'running', 'Sending PDF to Claude for extraction…');

  const stream = client.messages.stream({
    model:      'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{
      role:    'user',
      content: [
        {
          type:   'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 },
        },
        {
          type: 'text',
          text: buildExtractionPrompt(leagueName, parentName, sport),
        },
      ],
    }],
  });

  const response = await stream.finalMessage();
  const raw = response.content[0]?.text ?? '';
  if (!raw) throw new Error('Claude returned an empty response');

  // Extract JSON by finding the outermost { ... } — works regardless of
  // whether Claude wraps the response in a markdown code block or not.
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start)
    throw new Error('Claude response contained no JSON object');
  const extracted = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(extracted.rules)) throw new Error('Claude response missing "rules" array');

  return extracted;
}

// ── Main handler ──────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  // ── Legacy ingest gate ──────────────────────────────────────────────────────
  // This route uses the pre-V3 schema (no rulebook_version_id, no verbatim guard,
  // no coverage verification).  It is disabled by default to prevent unversioned
  // data from being written alongside V3 ingests.
  //
  // V3 replacement: node scripts/ingest-pdf.mjs <file> <league> --season <year>
  // To re-enable temporarily: set ALLOW_LEGACY_INGEST=true in your environment.
  if (process.env.ALLOW_LEGACY_INGEST !== 'true') {
    return res.status(403).json({
      error: 'Legacy ingest disabled.',
      message: 'Use the V3 CLI pipeline: node scripts/ingest-pdf.mjs <file> <league> --season <year>',
      hint: 'Set ALLOW_LEGACY_INGEST=true to temporarily re-enable (not recommended).',
    });
  }

  const {
    url, fileBase64, fileName,
    leagueSlug, newLeagueName, newLeagueSlug, parentSlug,
    sport   = 'baseball',
    replace: doReplace = false,
    dryRun  = false,
  } = req.body ?? {};

  if (!url && !fileBase64)             return res.status(400).json({ error: 'Provide url or fileBase64 + fileName' });
  if (!leagueSlug && !newLeagueName)   return res.status(400).json({ error: 'Provide leagueSlug or newLeagueName + newLeagueSlug' });
  if (newLeagueName && !newLeagueSlug) return res.status(400).json({ error: 'newLeagueName requires newLeagueSlug' });
  if (!process.env.DATABASE_URL)       return res.status(500).json({ error: 'DATABASE_URL not configured' });

  const ext   = fileBase64 ? (fileName ?? '').split('.').pop().toLowerCase() : null;
  const isPDF = ext === 'pdf';

  const { emit, done } = setupSSE(res);

  // SSE keepalive — prevents Vercel's CDN from closing idle connections
  // while Claude (or OpenAI) is processing a long request.
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 20000);

  try {

    // ── STEP 1: League lookup ────────────────────────────────────────────────
    // Done first so GPT-4o gets league context when reading PDFs.

    emit('league', 'running', 'Looking up league in database…');

    let leagueId, leagueName, parentId, parentName, parentIndex = [];

    await withDb(async c => {
      if (newLeagueName) {
        let pid = null, pname = null;
        if (parentSlug) {
          const { rows } = await c.query(`SELECT id, name FROM leagues WHERE slug=$1`, [parentSlug]);
          if (!rows.length) throw new Error(`Parent league "${parentSlug}" not found`);
          pid = rows[0].id; pname = rows[0].name;
        }
        const { rows } = await c.query(`
          INSERT INTO leagues (slug, name, parent_league_id, is_foundation, effective_date)
          VALUES ($1,$2,$3,$4,CURRENT_DATE)
          ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, parent_league_id=EXCLUDED.parent_league_id
          RETURNING id, name
        `, [newLeagueSlug, newLeagueName, pid, pid === null]);
        leagueId = rows[0].id; leagueName = rows[0].name;
        parentId = pid; parentName = pname;
      } else {
        const { rows } = await c.query(`
          SELECT l.id, l.name, l.parent_league_id, p.id AS parent_id, p.name AS parent_name
          FROM leagues l LEFT JOIN leagues p ON p.id = l.parent_league_id WHERE l.slug=$1
        `, [leagueSlug]);
        if (!rows.length) throw new Error(`League "${leagueSlug}" not found`);
        leagueId = rows[0].id; leagueName = rows[0].name;
        parentId = rows[0].parent_id; parentName = rows[0].parent_name;
      }

      if (parentId) {
        const { rows: pRows } = await c.query(
          `SELECT id, rule_number, title FROM rules WHERE league_id=$1 AND (sport=$2 OR sport='baseball') ORDER BY rule_number`,
          [parentId, sport],
        );
        parentIndex = pRows;
      }
    });

    emit('league', 'done',
      parentId
        ? `"${leagueName}" — parent: "${parentName}" (${parentIndex.length} rules)`
        : `"${leagueName}" — standalone / foundation rulebook`,
    );

    // ── STEP 2: Parse + Extract ──────────────────────────────────────────────

    let validRules;

    if (isPDF) {
      // ── PDF: GPT-4o reads the document natively (text + page images) ────────
      emit('parse', 'running', `PDF detected — sending to Claude for extraction…`);

      const extracted = await extractRulesWithClaude({
        fileBase64, leagueName, parentName, sport, emit,
      });

      validRules = (extracted.rules ?? []).filter(r => r.rule_number && r.title && r.body);
      emit('parse', 'done',
        `GPT-4o extracted ${validRules.length} rules (doc quality: ${extracted.document_quality})`,
        { sections: validRules.length },
      );

      // No separate AI chunking needed — skip that step
      emit('chunk', 'done',
        `Extraction complete — ${extracted.notes || 'no issues noted'}`,
        { rules: validRules.length, quality: extracted.document_quality },
      );

    } else {
      // ── URL / DOCX: text extraction → section split → AI chunker ────────────
      emit('parse', 'running', url ? `Fetching ${url}` : `Parsing ${fileName}`);

      let markdown;

      if (url) {
        const jinaRes = await fetch(`${JINA_BASE}${url}`, { headers: { Accept: 'text/markdown' } });
        if (!jinaRes.ok) throw new Error(`Jina Reader returned HTTP ${jinaRes.status}`);
        const raw = await jinaRes.text();
        if (!raw || raw.trim().length < 100) throw new Error('URL returned empty content — it may require login');
        markdown = normalizeMarkdown(raw, url);

      } else if (ext === 'docx') {
        const buf = Buffer.from(fileBase64, 'base64');
        const { default: mammoth } = await import('mammoth');
        const result = await mammoth.convertToHtml({ buffer: buf }, {
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
          ],
        });
        markdown = normalizeMarkdown(htmlToMarkdown(result.value), fileName);
      } else {
        throw new Error(`Unsupported file type ".${ext}" — use .pdf or .docx`);
      }

      const sections = splitIntoSections(markdown);
      if (sections.length < 2) throw new Error(`Only ${sections.length} section(s) found — document may lack rule structure`);
      emit('parse', 'done', `${sections.length} sections detected`, { sections: sections.length });

      // AI chunking in batches
      const batches    = chunk(sections, BATCH_SIZE);
      const allRules   = [];
      let   worstQuality = 'good';
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      emit('chunk', 'running', `${sections.length} sections → ${batches.length} batch${batches.length > 1 ? 'es' : ''}`);

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        emit('chunk', 'running', `Batch ${bIdx + 1}/${batches.length}…`);
        try {
          const result = await callChunkingAgent(openai, {
            sections:   batches[bIdx],
            leagueName, parentName: parentName ?? null, parentIndex, sport,
            batchLabel: `batch ${bIdx + 1}/${batches.length}`,
          });
          allRules.push(...(result.rules ?? []));
          if (result.document_quality === 'poor') worstQuality = 'poor';
          else if (result.document_quality === 'partial' && worstQuality === 'good') worstQuality = 'partial';
        } catch (err) {
          emit('chunk', 'running', `Batch ${bIdx + 1} failed: ${err.message} — continuing`);
        }
        if (bIdx < batches.length - 1) await sleep(DELAY_MS);
      }

      validRules = allRules.filter(r => r.rule_number && r.title && r.body);
      emit('chunk', 'done',
        `${validRules.length} rules extracted (quality: ${worstQuality})`,
        { rules: validRules.length, quality: worstQuality },
      );
    }

    if (validRules.length === 0)
      throw new Error('No valid rules extracted — document may lack recognizable rule structure');

    if (dryRun) {
      emit('complete', 'done',
        `Dry run — ${validRules.length} rules would be inserted`,
        { dryRun: true, rules: validRules.length,
          preview: validRules.slice(0, 20).map(r => ({ rule_number: r.rule_number, title: r.title })) },
      );
      return done();
    }

    // ── STEP 3: Write to DB ──────────────────────────────────────────────────

    emit('write', 'running', doReplace ? 'Clearing existing rules…' : 'Inserting rules…');

    const parentMap      = Object.fromEntries(parentIndex.map(p => [p.rule_number, p.id]));
    const rulesForInsert = validRules.map(r => ({
      rule_number:       String(r.rule_number).trim().slice(0, 100),
      title:             String(r.title).trim().slice(0, 500),
      body:              String(r.body).trim(),
      is_override:       !!r.is_override,
      overrides_rule_id: r.is_override && r.override_parent_rule_number
        ? (parentMap[r.override_parent_rule_number] ?? null) : null,
      confidence:        r.confidence ?? null,
    }));

    let inserted, skipped;
    await withDb(async c => {
      if (doReplace) {
        const del = await c.query(`DELETE FROM rules WHERE league_id=$1 RETURNING id`, [leagueId]);
        emit('write', 'running', `Cleared ${del.rowCount} existing rules`);
      }
      const result = await insertRulesTransaction(c, rulesForInsert, leagueId, sport);
      inserted = result.inserted;
      skipped  = result.skipped.length;
    });

    emit('write', 'done', `${inserted} inserted, ${skipped} skipped`, { inserted, skipped });

    // ── STEP 4: Embed ────────────────────────────────────────────────────────

    const { rows: unembedded } = await withDb(c => c.query(`
      SELECT r.id, r.rule_number, r.title, r.body
      FROM  rules r
      LEFT  JOIN rule_embeddings re ON re.rule_id=r.id AND re.model=$1
      WHERE r.league_id=$2 AND re.id IS NULL
    `, [EMBED_MODEL, leagueId]));

    if (!unembedded.length) {
      emit('embed', 'done', 'All rules already embedded', { embedded: 0 });
    } else {
      emit('embed', 'running', `Embedding ${unembedded.length} rules…`);
      const embedBatches = chunk(unembedded, EMBED_BATCH);
      let   totalEmbedded = 0;

      for (let bIdx = 0; bIdx < embedBatches.length; bIdx++) {
        const batch = embedBatches[bIdx];
        emit('embed', 'running', `Embedding batch ${bIdx + 1}/${embedBatches.length}…`);

        const embedRes = await fetch(`${OAI_BASE}/embeddings`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            model: EMBED_MODEL,
            input: batch.map(r => `Rule ${r.rule_number}: ${r.title}\n\n${r.body}`.trim()),
          }),
        });

        if (!embedRes.ok) { emit('embed', 'running', `Batch ${bIdx + 1} failed — continuing`); continue; }

        const { data: embedData } = await embedRes.json();
        await withDb(async c => {
          await c.query('BEGIN');
          for (let i = 0; i < batch.length; i++) {
            await c.query(
              `INSERT INTO rule_embeddings (rule_id,model,embedding) VALUES ($1,$2,$3::vector) ON CONFLICT DO NOTHING`,
              [batch[i].id, EMBED_MODEL, `[${embedData[i].embedding.join(',')}]`],
            );
          }
          await c.query('COMMIT');
        });

        totalEmbedded += batch.length;
        if (bIdx < embedBatches.length - 1) await sleep(DELAY_MS);
      }

      emit('embed', 'done', `${totalEmbedded} embeddings created`, { embedded: totalEmbedded });
    }

    // ── Complete ─────────────────────────────────────────────────────────────

    emit('complete', 'done',
      `Done — ${inserted} rules live in "${leagueName}"`,
      {
        leagueName, leagueSlug: leagueSlug ?? newLeagueSlug,
        inserted, skipped,
        preview: rulesForInsert.slice(0, 30).map(r => ({ rule_number: r.rule_number, title: r.title })),
      },
    );

  } catch (err) {
    console.error('[admin/ingest]', err);
    emit('error', 'error', err.message);
  } finally {
    clearInterval(keepAlive);
  }

  done();
};

export default withAdminAuth(handler);
