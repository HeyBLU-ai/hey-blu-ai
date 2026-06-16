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

const { Client } = pg;

export const maxDuration = 300;

const MAX_DOCX_BYTES = 15 * 1024 * 1024;
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
  if (!expected || password !== expected) {
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

function parseMultipart(buffer, headers) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;
    let filename = '';

    const busboy = Busboy({ headers });
    busboy.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
        filename = info.filename ?? '';
      });
    });
    busboy.on('field', (name, value) => {
      fields[name] = String(value ?? '');
    });
    busboy.on('finish', () => resolve({ fields, fileBuffer, filename }));
    busboy.on('error', reject);
    busboy.end(buffer);
  });
}

async function parsePayload(req) {
  const contentType = String(req.headers['content-type'] ?? '');

  if (contentType.includes('multipart/form-data')) {
    const raw = await readRequestBody(req);
    if (!raw?.length) throw new Error('Empty multipart body');
    const { fields, fileBuffer, filename } = await parseMultipart(raw, req.headers);
    return {
      leagueName: sanitizeText(fields.league_name ?? fields.leagueName ?? '', 120),
      leagueSlug: sanitizeText(fields.league_slug ?? fields.leagueSlug ?? '', 80).toLowerCase(),
      season: sanitizeText(fields.season ?? String(new Date().getFullYear()), 8),
      fallbackLeagueSlug: sanitizeText(
        fields.fallback_league_slug ?? fields.fallbackLeagueSlug ?? '',
        80,
      ).toLowerCase(),
      filename: sanitizeText(filename || fields.filename || 'upload.docx', 255),
      fileBuffer,
    };
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid JSON body');
  }

  const fileBase64 = String(body.file_base64 ?? '').trim();
  let fileBuffer = null;
  if (fileBase64) {
    try {
      fileBuffer = Buffer.from(fileBase64, 'base64');
    } catch {
      throw new Error('file_base64 is not valid base64');
    }
  }

  return {
    leagueName: sanitizeText(body.league_name ?? body.leagueName ?? '', 120),
    leagueSlug: sanitizeText(body.league_slug ?? body.leagueSlug ?? '', 80).toLowerCase(),
    season: sanitizeText(body.season ?? String(new Date().getFullYear()), 8),
    fallbackLeagueSlug: sanitizeText(
      body.fallback_league_slug ?? body.fallbackLeagueSlug ?? '',
      80,
    ).toLowerCase(),
    filename: sanitizeText(body.filename ?? 'upload.docx', 255),
    fileBuffer,
  };
}

async function applyFallbackLeague(client, leagueId, fallbackSlug) {
  if (!fallbackSlug) return null;
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
    payload = await parsePayload(req);
  } catch (err) {
    return res.status(400).json({ error: err.message ?? 'Invalid request body' });
  }

  const {
    leagueName,
    leagueSlug,
    season,
    fallbackLeagueSlug,
    filename,
    fileBuffer,
  } = payload;

  if (!leagueSlug) {
    return res.status(400).json({ error: 'league_slug is required' });
  }
  if (!SLUG_RE.test(leagueSlug)) {
    return res.status(400).json({
      error: 'league_slug must be lowercase kebab-case (e.g. nsll-minors-aaa)',
    });
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
    await client.query('BEGIN');

    const result = await runDocxIngest({
      dbClient: client,
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

    const league = await resolveLeagueBySlug(client, leagueSlug);
    if (leagueName) {
      await client.query(`
        UPDATE leagues SET name = $1, updated_at = now() WHERE id = $2
      `, [leagueName, league.id]);
      result.league_name = leagueName;
    }

    let fallbackApplied = null;
    if (fallbackLeagueSlug) {
      fallbackApplied = await applyFallbackLeague(client, league.id, fallbackLeagueSlug);
      steps.push({
        step: 'fallback',
        message: `Linked fallback rulebook → ${fallbackApplied}`,
        at: new Date().toISOString(),
      });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      ...result,
      fallback_league_slug: fallbackApplied,
      steps,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
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
