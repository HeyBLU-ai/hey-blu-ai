/**
 * POST /api/admin/ingest-canonical
 *
 * Secure admin endpoint: accepts a PDF (base64) + league slug and runs the
 * full canonical graph pipeline (extract → canonicalize → embed → activate).
 *
 * Auth: Authorization: Bearer <ADMIN_PASSWORD>
 *
 * Request JSON:
 *   {
 *     "league_slug": "mlb",
 *     "season": "2026",
 *     "filename": "2026-MLB-rules-only.pdf",
 *     "file_base64": "<base64-encoded PDF bytes>"
 *   }
 *
 * Response 200:
 *   { success: true, version_id, extraction_run_id, node_count, ... }
 */

import pg from 'pg';
import OpenAI from 'openai';
import { runCanonicalIngestFromPdf } from '../../lib/ingest/canonical-pipeline.mjs';

const { Client } = pg;

export const maxDuration = 300;

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB raw

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

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body ?? null;
}

const handler = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  const leagueSlug = String(body.league_slug ?? '').trim().toLowerCase();
  const season     = String(body.season ?? new Date().getFullYear()).trim();
  const filename   = String(body.filename ?? 'upload.pdf').trim();
  const fileBase64 = String(body.file_base64 ?? '').trim();

  if (!leagueSlug) {
    return res.status(400).json({ error: 'league_slug is required' });
  }
  if (!fileBase64) {
    return res.status(400).json({ error: 'file_base64 is required' });
  }
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'Only PDF files are supported' });
  }

  let pdfBuffer;
  try {
    pdfBuffer = Buffer.from(fileBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'file_base64 is not valid base64' });
  }

  if (!pdfBuffer.length) {
    return res.status(400).json({ error: 'Uploaded file is empty' });
  }
  if (pdfBuffer.length > MAX_PDF_BYTES) {
    return res.status(413).json({
      error: 'file_too_large',
      message: `PDF exceeds ${MAX_PDF_BYTES / (1024 * 1024)} MB limit. Use the CLI for very large files.`,
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

    const result = await runCanonicalIngestFromPdf({
      dbClient:   client,
      leagueSlug,
      season,
      pdfBuffer,
      filename,
      openai,
      onProgress(step, message) {
        steps.push({ step, message, at: new Date().toISOString() });
      },
    });

    await client.query('COMMIT');

    return res.status(200).json({
      ...result,
      steps,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[admin/ingest-canonical]', err);
    return res.status(500).json({
      error:   'ingest_failed',
      message: err.message ?? 'Canonical ingest failed',
      steps,
    });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};

export default withAdminAuth(handler);
