/**
 * POST /api/admin/ingest
 *
 * Secure admin endpoint: accepts a DOCX rulebook + league metadata and runs the
 * streamlined docx-markdown pipeline (parse → chunk → embed → activate).
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 *       (also accepts ADMIN_SECRET when ADMIN_PASSWORD is unset)
 *
 * Accepts either:
 *   - multipart/form-data (browser FormData)
 *   - application/json { league_name, league_slug, season, fallback_league_slug,
 *                        filename, file_base64 }
 *
 * Response 200:
 *   { success: true, version_id, node_count, chunk_count, ... }
 */

import Busboy from '@fastify/busboy';
import pg from 'pg';
import OpenAI from 'openai';
import { runDocxIngest } from '../../lib/ingest/docx-pipeline.mjs';
import { resolveLeagueBySlug } from '../../lib/ingest/canonical-pipeline.mjs';
import { safeCompareSecret } from '../../lib/auth-safe-compare.mjs';

const { Client } = pg;

export const maxDuration = 300;

/** Vercel request payload cap is ~4.5 MB — stay under it. */
const MAX_DOCX_BYTES = Math.floor(4.5 * 1024 * 1024);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function adminPassword() {
  return process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
}

const withAdminAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expected = adminPassword();
  const password = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || !safeCompareSecret(password, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return handler(req, res);
};

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function normalizeMetadata(fields) {
  return {
    leagueName: sanitizeText(fields.league_name ?? fields.leagueName ?? '', 120),
    leagueSlug: sanitizeText(fields.league_slug ?? fields.leagueSlug ?? '', 80).toLowerCase(),
    season: sanitizeText(fields.season ?? String(new Date().getFullYear()), 8),
    fallbackLeagueSlug: sanitizeText(
      fields.fallback_league_slug ?? fields.fallbackLeagueSlug ?? '',
      80,
    ).toLowerCase(),
  };
}

function validateMetadata(meta) {
  if (!meta.leagueSlug) {
    return 'league_slug is required';
  }
  if (!SLUG_RE.test(meta.leagueSlug)) {
    return 'league_slug must be lowercase kebab-case (e.g. nsll-minors-aaa)';
  }
  if (meta.fallbackLeagueSlug && meta.fallbackLeagueSlug === meta.leagueSlug) {
    return 'fallback_league_slug cannot be the same as league_slug';
  }
  return null;
}

async function readRequestBody(req) {
  if (req.body != null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    if (typeof req.body === 'object') return null;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Fail-fast: extract league metadata without decoding file payloads.
 */
async function extractRequestMetadata(req) {
  const contentType = String(req.headers['content-type'] ?? '');

  if (contentType.includes('multipart/form-data')) {
    const raw = await readRequestBody(req);
    if (!raw?.length) throw new Error('Empty multipart body');

    return new Promise((resolve, reject) => {
      const fields = {};
      let fileBuffer = null;
      let filename = '';
      let fileRejected = false;

      const busboy = Busboy({ headers: req.headers });
      busboy.on('field', (name, value) => {
        fields[name] = String(value ?? '');
      });
      busboy.on('file', (_name, stream, info) => {
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          if (fileRejected) return;
          size += c.length;
          if (size > MAX_DOCX_BYTES) {
            fileRejected = true;
            reject(new Error(`DOCX exceeds ${MAX_DOCX_BYTES / (1024 * 1024)} MB limit.`));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => {
          if (fileRejected) return;
          fileBuffer = Buffer.concat(chunks);
          filename = info.filename ?? '';
        });
      });
      busboy.on('finish', () => {
        if (fileRejected) return;
        resolve({
          ...normalizeMetadata(fields),
          filename: sanitizeText(filename || fields.filename || 'upload.docx', 255),
          fileBuffer,
        });
      });
      busboy.on('error', reject);
      busboy.end(raw);
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid JSON body');
  }

  const meta = normalizeMetadata(body);
  const fileBase64 = String(body.file_base64 ?? '').trim();

  return {
    ...meta,
    filename: sanitizeText(body.filename ?? 'upload.docx', 255),
    fileBase64: fileBase64 || null,
  };
}

function decodeRequestFile(payload) {
  if (payload.fileBuffer != null) {
    return payload.fileBuffer;
  }
  if (!payload.fileBase64) return null;

  const estimatedBytes = Math.floor((payload.fileBase64.length * 3) / 4);
  if (estimatedBytes > MAX_DOCX_BYTES) {
    throw new Error(`DOCX exceeds ${MAX_DOCX_BYTES / (1024 * 1024)} MB limit.`);
  }
  let fileBuffer;
  try {
    fileBuffer = Buffer.from(payload.fileBase64, 'base64');
  } catch {
    throw new Error('file_base64 is not valid base64');
  }
  if (fileBuffer.length > MAX_DOCX_BYTES) {
    throw new Error(`DOCX exceeds ${MAX_DOCX_BYTES / (1024 * 1024)} MB limit.`);
  }
  return fileBuffer;
}

/**
 * @param {import('pg').Client} client
 * @param {string} fallbackSlug
 */
async function verifyFallbackLeagueExists(client, fallbackSlug) {
  const { rows } = await client.query(
    `SELECT id FROM leagues WHERE slug = $1`,
    [fallbackSlug],
  );
  if (!rows.length) {
    throw new Error(`fallback_league_slug "${fallbackSlug}" does not exist`);
  }
}

async function applyFallbackLeague(client, leagueId, fallbackSlug) {
  const fallback = await resolveLeagueBySlug(client, fallbackSlug);
  if (fallback.id === leagueId) {
    throw new Error('fallback_league_slug cannot be the same as league_slug');
  }
  await client.query(`
    UPDATE leagues
    SET fallback_league_id = $1, updated_at = now()
    WHERE id = $2
  `, [fallback.id, leagueId]);
  return fallback.slug;
}

const handler = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  let payload;
  try {
    payload = await extractRequestMetadata(req);
  } catch (err) {
    const message = err.message ?? 'Invalid request body';
    const status = message.includes('exceeds') ? 413 : 400;
    return res.status(status).json({ error: message });
  }

  const {
    leagueName,
    leagueSlug,
    season,
    fallbackLeagueSlug,
    filename,
  } = payload;

  const metaError = validateMetadata({ leagueSlug, fallbackLeagueSlug });
  if (metaError) {
    return res.status(400).json({ error: metaError });
  }

  // Fail-fast: verify fallback exists before decoding files or running ingest.
  if (fallbackLeagueSlug) {
    const precheck = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    try {
      await precheck.connect();
      await verifyFallbackLeagueExists(precheck, fallbackLeagueSlug);
    } catch (err) {
      return res.status(400).json({ error: err.message ?? 'Invalid fallback_league_slug' });
    } finally {
      try { await precheck.end(); } catch { /* ignore */ }
    }
  }

  let fileBuffer;
  try {
    fileBuffer = decodeRequestFile(payload);
  } catch (err) {
    const message = err.message ?? 'Invalid file payload';
    const status = message.includes('exceeds') ? 413 : 400;
    return res.status(status).json({ error: message });
  }

  if (!fileBuffer?.length) {
    return res.status(400).json({ error: 'DOCX file is required' });
  }
  if (!filename.toLowerCase().endsWith('.docx')) {
    return res.status(400).json({ error: 'Only .docx files are supported' });
  }
  if (fileBuffer.length > MAX_DOCX_BYTES) {
    return res.status(413).json({
      error: 'file_too_large',
      message: `DOCX exceeds ${MAX_DOCX_BYTES / (1024 * 1024)} MB limit.`,
    });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const steps = [];

  try {
    await client.connect();

    const result = await runDocxIngest({
      dbClient: client,
      connectionString: process.env.DATABASE_URL,
      leagueSlug,
      leagueName: leagueName || undefined,
      season,
      docxBuffer: fileBuffer,
      filename,
      openai,
      onProgress(step, message) {
        steps.push({ step, message, at: new Date().toISOString() });
      },
    });

    let fallbackApplied = null;
    if (fallbackLeagueSlug) {
      await client.query('BEGIN');
      try {
        const league = await resolveLeagueBySlug(client, leagueSlug);
        fallbackApplied = await applyFallbackLeague(client, league.id, fallbackLeagueSlug);
        await client.query('COMMIT');
        steps.push({
          step: 'fallback',
          message: `Linked fallback rulebook → ${fallbackApplied}`,
          at: new Date().toISOString(),
        });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    }

    return res.status(200).json({
      ...result,
      fallback_league_slug: fallbackApplied,
      steps,
    });
  } catch (err) {
    console.error('[admin/ingest]', err);
    return res.status(500).json({
      error: 'ingest_failed',
      message: err.message ?? 'DOCX ingest failed',
      steps,
    });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};

export default withAdminAuth(handler);
