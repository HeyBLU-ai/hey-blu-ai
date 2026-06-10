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

// ── GPT-4o PDF extraction ─────────────────────────────────────────────────────
// Uploads the PDF to OpenAI's Files API and asks GPT-4o to read and extract
// rules directly, understanding the document structure visually.

const RULES_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule_number:               { type: 'string' },
          title:                     { type: 'string' },
          body:                      { type: 'string' },
          is_override:               { type: 'boolean' },
          override_parent_rule_number: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence:                { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['rule_number', 'title', 'body', 'is_override', 'override_parent_rule_number', 'confidence'],
        additionalProperties: false,
      },
    },
    document_quality: { type: 'string', enum: ['good', 'partial', 'poor'] },
    notes:            { type: 'string' },
  },
  required: ['rules', 'document_quality', 'notes'],
  additionalProperties: false,
};

function buildExtractionPrompt(leagueName, parentName, sport) {
  return `You are extracting the complete rulebook for "${leagueName}" (sport: ${sport}).
${parentName ? `This league is based on "${parentName}" rules and may contain local overrides or additions.` : ''}

Read this PDF carefully. For EVERY rule, regulation, and local modification in the document, extract:

- rule_number: The official identifier (e.g. "1.01", "Rule 5", "Section 3", "A", "MUST SLIDE RULE"). Use the document's own numbering. If a rule has no number, create a short slug like "must-slide".
- title: 3–10 word descriptive title capturing the rule's topic.
- body: The COMPLETE rule text. Include all sub-clauses, exceptions, and penalties.
- is_override: true ONLY if this rule explicitly modifies or replaces a rule from the parent/governing rulebook (${parentName ?? 'MLB OBR'}). Local additions are NOT overrides.
- override_parent_rule_number: If is_override is true, the parent rule number being modified. Otherwise null.
- confidence: "high" if rule boundary is unambiguous, "medium" if uncertain, "low" if guessing.

IMPORTANT:
- Extract EVERY rule. Do not skip rules because they seem minor.
- When a rule has lettered sub-sections (a), (b), (c)... that cover DISTINCT topics an umpire might look up independently, split them into separate rule objects with rule_number like "5.10(a)", "5.10(b)".
- Do NOT split numbered sub-clauses (1), (2), (3) within the same letter — keep those together.
- Skip table of contents, page headers/footers, and administrative preamble that are not actual rules.

document_quality: "good" if document is clean and complete, "partial" if some rules were unclear, "poor" if document was mostly unreadable.
notes: Brief summary of any issues encountered.`;
}

async function extractRulesWithGPT4o({ buf, fileName, leagueName, parentName, sport, emit }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  // 1. Upload PDF to OpenAI Files API
  emit('parse', 'running', 'Uploading PDF to OpenAI…');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), fileName);
  form.append('purpose', 'user_data');

  const uploadRes = await fetch(`${OAI_BASE}/files`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body:    form,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}));
    throw new Error(`OpenAI file upload failed: ${err.error?.message ?? uploadRes.status}`);
  }
  const { id: fileId } = await uploadRes.json();
  emit('parse', 'running', 'PDF uploaded — GPT-5.5 reading document…');

  // 2. Extract rules via Responses API (GPT-4o reads text + page images natively)
  let extracted;
  try {
    const extractRes = await fetch(`${OAI_BASE}/responses`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:              'gpt-5.5',
        max_output_tokens:  32768,
        input: [
          {
            role:    'user',
            content: [
              { type: 'input_file', file_id: fileId },
              { type: 'input_text', text: buildExtractionPrompt(leagueName, parentName, sport) },
            ],
          },
        ],
        text: {
          format: {
            type:   'json_schema',
            name:   'rules_extraction',
            strict: true,
            schema: RULES_SCHEMA,
          },
        },
      }),
    });

    if (!extractRes.ok) {
      const err = await extractRes.json().catch(() => ({}));
      throw new Error(`GPT-4o extraction failed: ${err.error?.message ?? extractRes.status}`);
    }

    const data = await extractRes.json();

    // Responses API: output is an array that may contain reasoning blocks
    // before the actual message — find the first message item explicitly.
    const messageItem = data.output?.find(o => o.type === 'message');
    const textItem    = messageItem?.content?.find(c => c.type === 'output_text' || c.type === 'text');
    const text        = textItem?.text ?? data.output_text ?? null;

    if (!text) {
      const preview = JSON.stringify(data).slice(0, 600);
      throw new Error(`GPT-5.5 returned no usable text. Response preview: ${preview}`);
    }
    extracted = JSON.parse(text);

  } finally {
    // 3. Delete the uploaded file (best effort cleanup)
    fetch(`${OAI_BASE}/files/${fileId}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }).catch(() => {});
  }

  return extracted;
}

// ── Main handler ──────────────────────────────────────────────────────────────

const handler = async (req, res) => {
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
      emit('parse', 'running', `PDF detected — sending to GPT-5.5 for direct extraction…`);

      const buf = Buffer.from(fileBase64, 'base64');
      const extracted = await extractRulesWithGPT4o({
        buf, fileName, leagueName, parentName, sport, emit,
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
  }

  done();
};

export default withAdminAuth(handler);
