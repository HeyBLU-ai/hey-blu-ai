/**
 * ARCHIVED — DO NOT DEPLOY
 *
 * This is the pre-V3 legacy admin ingest handler, preserved here for
 * reference only.  It uses the old summarisation schema:
 *   "Concise 40–100 word summary. Do NOT copy verbatim."
 * which has been superseded by the V3 verbatim-source pipeline in
 * lib/ingest/ and scripts/ingest-pdf.mjs.
 *
 * The active API endpoint at api/admin/ingest.js now returns HTTP 410
 * and never executes any of the code below.
 *
 * To run the V3 pipeline:
 *   node scripts/ingest-pdf.mjs <file> <league-slug> --season <year>
 */

// Hard fail — this file must never execute in a production environment.
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'Legacy ingest disabled in production. ' +
    'Use the V3 CLI: node scripts/ingest-pdf.mjs <file> <league> --season <year>',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Everything below is the verbatim original implementation, archived on
// 2026-06-13 during the V3 data-layer migration.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';
import {
  callChunkingAgent,
  insertRulesTransaction,
  splitIntoSections,
  chunk,
} from '../../api/ingest/structure.js';

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

// ── Markdown normalization ────────────────────────────────────────────────────

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
// NOTE: This prompt uses the OLD summarisation approach (Concise 40–100 words,
// Do NOT copy verbatim).  The V3 pipeline in lib/ingest/ uses verbatim source
// slicing instead.

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

export default withAdminAuth(async (req, res) => {
  console.warn('[LEGACY] admin-ingest-legacy.mjs executed — this should never happen in production');
  res.status(410).json({ error: 'legacy_ingest_disabled', message: 'This handler is archived.' });
});
