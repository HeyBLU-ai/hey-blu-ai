/**
 * Local development server for HeyBLU.
 *
 * Serves static files from the project root AND proxies /api/* requests to
 * the serverless function handlers — no Vercel CLI required.
 *
 * Usage:
 *   node dev-server.mjs
 *
 * Then open: http://localhost:3000/rulebook
 *
 * Requires: .env.local (run `vercel env pull .env.local` once to create it).
 */

import http        from 'http';
import fs          from 'fs/promises';
import path        from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3000;

// ── Load .env.local ───────────────────────────────────────────────────────────

try {
  const raw = await fs.readFile(path.join(__dirname, '.env.local'), 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eqIdx = t.indexOf('=');
    if (eqIdx < 0) continue;
    const key = t.slice(0, eqIdx).trim();
    const val = t.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('  ✓  Loaded .env.local');
} catch {
  console.warn('  ⚠  .env.local not found — API calls needing OPENAI_API_KEY will fail');
  console.warn('     Run: vercel env pull .env.local\n');
}

// ── Import API handlers (after env is loaded) ─────────────────────────────────

const { default: askV2Handler }       = await import('./api/ask-v2.js');
const { default: getLeaguesHandler }  = await import('./api/get-leagues.js');
const { default: askHandler }         = await import('./api/ask.js').catch(() => ({ default: null }));
const { default: adminLeaguesHandler } = await import('./api/admin/leagues.js');
const { default: adminRulesHandler }   = await import('./api/admin/rules.js');
const { default: adminIngestHandler }  = await import('./api/admin/ingest.js');
const { default: adminWarningsHandler } = await import('./api/admin/warnings.js');
const { default: adminRuleNodesHandler } = await import('./api/admin/rule-nodes.js');
const { default: adminIngestCanonicalHandler } = await import('./api/admin/ingest-canonical.js');
const { default: submitFeedbackHandler } = await import('./api/submit-feedback.js');
const { default: adminFeedbackHandler } = await import('./api/admin/feedback.js');

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.txt':  'text/plain',
  '.xml':  'text/xml',
  '.webmanifest': 'application/manifest+json',
};

// ── URL → file path resolution (mirrors vercel.json routes) ──────────────────

function resolveStaticPath(pathname) {
  // Strip query string
  const p = pathname.split('?')[0];

  // Known directory routes → index.html
  const dirRoutes = [
    '/rulebook', '/betablu', '/faq', '/compare', '/pricing', '/support',
    '/about', '/zone', '/own', '/survey', '/field-guide', '/privacy',
    '/terms', '/market', '/revenuesprint', '/use-of-funds', '/vision', '/admin',
  ];

  for (const route of dirRoutes) {
    if (p === route || p === route + '/') {
      return path.join(__dirname, route, 'index.html');
    }
    if (p.startsWith(route + '/')) {
      return path.join(__dirname, p);
    }
  }

  // Root
  if (p === '/' || p === '') return path.join(__dirname, 'index.html');

  // Everything else: try directly
  return path.join(__dirname, p);
}

// ── Request body parser ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  ()    => {
      try   { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Minimal res wrapper (mirrors what Vercel serverless provides) ─────────────

function makeRes(nodeRes) {
  const headers = {};
  return {
    _ended: false,
    setHeader(k, v)  { headers[k] = v; nodeRes.setHeader(k, v); },
    getHeader(k)     { return headers[k]; },
    status(code)     { nodeRes.statusCode = code; return this; },
    // writeHead + write support SSE streaming handlers
    writeHead(code, hdrs = {}) {
      nodeRes.statusCode = code;
      for (const [k, v] of Object.entries(hdrs)) nodeRes.setHeader(k, v);
    },
    write(chunk)     { nodeRes.write(chunk); },
    json(data)       {
      if (this._ended) return this;
      this._ended = true;
      nodeRes.setHeader('Content-Type', 'application/json');
      nodeRes.end(JSON.stringify(data));
      return this;
    },
    end(body = '')   {
      if (this._ended) return this;
      this._ended = true;
      nodeRes.end(body);
      return this;
    },
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method   = req.method || 'GET';

  // ── CORS pre-flight ────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API routes ─────────────────────────────────────────────────────────────

  if (pathname === '/api/ask-v2') {
    req.body = await readBody(req);
    return askV2Handler(req, makeRes(res));
  }

  if (pathname === '/api/ask' && askHandler) {
    req.body = await readBody(req);
    return askHandler(req, makeRes(res));
  }

  if (pathname === '/api/get-leagues') {
    req.body = {};
    return getLeaguesHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/leagues') {
    req.body = {};
    return adminLeaguesHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/rules') {
    req.query = Object.fromEntries(url.searchParams);
    req.body  = {};
    return adminRulesHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/ingest') {
    req.body = await readBody(req);
    return adminIngestHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/warnings') {
    req.query = Object.fromEntries(url.searchParams);
    req.body  = method === 'POST' ? await readBody(req) : {};
    return adminWarningsHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/rule-nodes') {
    req.query = Object.fromEntries(url.searchParams);
    req.body  = method === 'PUT' ? await readBody(req) : {};
    return adminRuleNodesHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/ingest-canonical') {
    req.body = await readBody(req);
    return adminIngestCanonicalHandler(req, makeRes(res));
  }

  if (pathname === '/api/submit-feedback') {
    req.body = await readBody(req);
    return submitFeedbackHandler(req, makeRes(res));
  }

  if (pathname === '/api/admin/feedback') {
    req.query = Object.fromEntries(url.searchParams);
    req.body  = {};
    return adminFeedbackHandler(req, makeRes(res));
  }

  // ── Static files ───────────────────────────────────────────────────────────

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  const filePath = resolveStaticPath(pathname);

  // Security: stay within project root
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext     = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${pathname}`);
    } else {
      console.error('Static file error:', err.message);
      res.writeHead(500); res.end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────────────┐
  │  HeyBLU local dev server                            │
  │                                                     │
  │  Homepage:   http://localhost:${PORT}/               │
  │  Rulebook:   http://localhost:${PORT}/rulebook        │
  │  Admin:      http://localhost:${PORT}/admin           │
  │  API (v2):   http://localhost:${PORT}/api/ask-v2      │
  │                                                     │
  │  Press Ctrl+C to stop                               │
  └─────────────────────────────────────────────────────┘
  `);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗  Port ${PORT} is already in use.`);
    console.error(`     Kill the other process first, then re-run.\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
