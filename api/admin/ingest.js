/**
 * POST /api/admin/ingest — PERMANENTLY DISABLED (HTTP 410 Gone)
 *
 * The legacy admin ingest endpoint has been replaced by the V3 CLI pipeline.
 * This file intentionally returns 410 Gone for every request so that:
 *   1. The route cannot be re-enabled by any environment variable.
 *   2. The legacy summarisation prompt never executes on production infrastructure.
 *
 * V3 replacement:
 *   node scripts/ingest-pdf.mjs <file> <league-slug> --season <year>
 *
 * The archived original implementation lives at:
 *   scripts/legacy/admin-ingest-legacy.mjs
 */

export const maxDuration = 5;

export default function handler(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (_req.method === 'OPTIONS') return res.status(204).end();

  return res.status(410).json({
    error:   'legacy_ingest_disabled',
    message: 'Legacy admin ingest is disabled. Use the V3 CLI ingestion pipeline.',
    docs:    'node scripts/ingest-pdf.mjs <file> <league-slug> --season <year>',
  });
}
