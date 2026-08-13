/**
 * GET  /api/daily20          — list wall entries (no image bytes)
 * GET  /api/daily20?image=id — serve heatmap image
 * GET  /api/daily20?auth=1   — ping ADMIN_PASSWORD (Bearer)
 * POST /api/daily20          — public submit { pitcher, date?, file_base64, mime, _gotcha }
 * DELETE /api/daily20?id=    — Bearer ADMIN_PASSWORD
 */
import pg from 'pg';
import { safeCompareSecret } from '../lib/auth-safe-compare.mjs';

const { Client } = pg;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

function db() {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = sanitize(String(value || ''), 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return todayIso();
}

function formatDate(value) {
  if (!value) return todayIso();
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return todayIso();
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS daily20_entries (
      id SERIAL PRIMARY KEY,
      pitcher TEXT NOT NULL,
      entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
      strike_pct DOUBLE PRECISION,
      top_velo DOUBLE PRECISION,
      avg_velo DOUBLE PRECISION,
      image_mime TEXT NOT NULL,
      image_bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function decodeBase64Image(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const cleaned = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  try {
    const buf = Buffer.from(cleaned, 'base64');
    if (!buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function listEntries(res) {
  if (!process.env.DATABASE_URL) {
    return res.status(200).json({ entries: [] });
  }
  const client = db();
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(`
      SELECT id, pitcher, entry_date, strike_pct, top_velo, avg_velo
      FROM daily20_entries
      ORDER BY entry_date DESC, id DESC
    `);
    return res.status(200).json({
      entries: rows.map((row) => ({
        id: row.id,
        pitcher: row.pitcher,
        date: formatDate(row.entry_date),
        strikePct: row.strike_pct,
        topVelo: row.top_velo,
        avgVelo: row.avg_velo,
        src: `/api/daily20?image=${row.id}`,
      })),
    });
  } catch (err) {
    console.error('[daily20 list]', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

async function serveImage(req, res) {
  const id = Number(req.query?.image);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid image id' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(404).json({ error: 'Not found' });
  }
  const client = db();
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(
      'SELECT image_mime, image_bytes FROM daily20_entries WHERE id = $1',
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const mime = rows[0].image_mime || 'image/jpeg';
    const bytes = rows[0].image_bytes;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(200).end(bytes);
  } catch (err) {
    console.error('[daily20 image]', err);
    return res.status(500).json({ error: 'Database error' });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

async function submit(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (sanitize(body._gotcha || '', 80)) {
    return res.status(200).json({ ok: true });
  }
  const pitcher = sanitize(body.pitcher || '', 80);
  if (!pitcher) return res.status(400).json({ error: 'Pitcher name is required' });

  const mime = ALLOWED_MIME[String(body.mime || body.type || 'image/jpeg').toLowerCase()];
  if (!mime) return res.status(400).json({ error: 'Use a JPEG, PNG, or WebP heatmap' });

  const image = decodeBase64Image(body.file_base64 || body.image || '');
  if (!image) return res.status(400).json({ error: 'Heatmap image is required' });
  if (image.length > MAX_IMAGE_BYTES) {
    return res.status(400).json({ error: 'Image must be 2 MB or smaller' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  const client = db();
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(
      `INSERT INTO daily20_entries (pitcher, entry_date, strike_pct, top_velo, avg_velo, image_mime, image_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, pitcher, entry_date, strike_pct, top_velo, avg_velo`,
      [
        pitcher,
        normalizeDate(body.date),
        optionalNumber(body.strikePct),
        optionalNumber(body.topVelo),
        optionalNumber(body.avgVelo),
        mime,
        image,
      ],
    );
    const row = rows[0];
    return res.status(200).json({
      ok: true,
      entry: {
        id: row.id,
        pitcher: row.pitcher,
        date: formatDate(row.entry_date),
        strikePct: row.strike_pct,
        topVelo: row.top_velo,
        avgVelo: row.avg_velo,
        src: `/api/daily20?image=${row.id}`,
      },
    });
  } catch (err) {
    console.error('[daily20 submit]', err);
    return res.status(500).json({ error: 'Could not save heatmap' });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || '';
  const password = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!safeCompareSecret(password, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function pingAuth(req, res) {
  if (!requireAdmin(req, res)) return;
  return res.status(200).json({ ok: true });
}

async function remove(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.query?.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }
  const client = db();
  try {
    await client.connect();
    await ensureTable(client);
    await client.query('DELETE FROM daily20_entries WHERE id = $1', [id]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[daily20 delete]', err);
    return res.status(500).json({ error: 'Could not delete' });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    if (req.query?.auth != null && req.query.auth !== '') return pingAuth(req, res);
    if (req.query?.image != null && req.query.image !== '') return serveImage(req, res);
    return listEntries(res);
  }
  if (req.method === 'POST') return submit(req, res);
  if (req.method === 'DELETE') return remove(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}
