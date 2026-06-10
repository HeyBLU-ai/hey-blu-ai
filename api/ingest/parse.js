/**
 * Universal Normalization Layer — POST /api/ingest/parse
 *
 * Accepts a JSON body with ONE of:
 *   { url: string }                              — public web URL
 *   { fileBase64: string, fileName: string }     — base64-encoded file
 *
 * Supported file types: .pdf  .docx
 * Supported URL types:  any public http/https page
 *
 * Returns:
 *   200 { success: true,  markdown: string, source: string, method: string }
 *   4xx { success: false, error: string,    detail?: string }
 *   500 { success: false, error: string }
 *
 * Required environment variables:
 *   INGEST_API_KEY        — simple bearer token guarding this admin endpoint
 *   LLAMA_CLOUD_API_KEY   — LlamaIndex Cloud key for PDF parsing
 *
 * NOTE: PDF parsing via LlamaParse is asynchronous and can take 20–60 seconds.
 * Vercel Hobby plan functions time out at 10 s. Upgrade to Pro for the 60 s limit,
 * or run this locally (vercel dev) for development ingestion.
 */

import mammoth from 'mammoth';
import LlamaCloud from '@llamaindex/llama-cloud';

// ─── Constants ───────────────────────────────────────────────────────────────

const JINA_BASE      = 'https://r.jina.ai/';
const PARSE_TIMEOUT  = 55_000;   // ms — stays inside Vercel Pro 60 s window
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB base64 payload limit

// ─── CORS / Auth middleware ───────────────────────────────────────────────────

const withIngestAuth = (handler) => async (req, res) => {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ success: false, error: 'Method not allowed' });

  const expectedKey = process.env.INGEST_API_KEY;
  if (!expectedKey) {
    return res.status(500).json({ success: false, error: 'Server misconfiguration: INGEST_API_KEY not set' });
  }

  const authHeader = req.headers.authorization || '';
  const providedKey = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  return handler(req, res);
};

// ─── Main handler ─────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  const { url, fileBase64, fileName } = req.body ?? {};

  // ── Input validation ─────────────────────────────────────────────────────

  const hasUrl  = typeof url === 'string' && url.trim().length > 0;
  const hasFile = typeof fileBase64 === 'string' && typeof fileName === 'string';

  if (!hasUrl && !hasFile) {
    return res.status(400).json({
      success: false,
      error:   'Provide either "url" (string) or "fileBase64" + "fileName" (strings).',
    });
  }
  if (hasUrl && hasFile) {
    return res.status(400).json({
      success: false,
      error:   'Provide either "url" or a file, not both.',
    });
  }

  // ── Route to appropriate parser ──────────────────────────────────────────

  try {
    let markdown;
    let method;
    let source;

    if (hasUrl) {
      ({ markdown, method, source } = await parseUrl(url.trim()));
    } else {
      if (fileBase64.length > MAX_BODY_BYTES * 1.4) {   // base64 overhead ~1.37×
        return res.status(413).json({ success: false, error: 'File exceeds 20 MB limit.' });
      }
      ({ markdown, method, source } = await parseFile(fileBase64, fileName.trim()));
    }

    return res.status(200).json({ success: true, markdown, source, method });

  } catch (err) {
    console.error('[ingest/parse] Unhandled error:', err);
    return res.status(500).json({
      success: false,
      error:   'Parsing failed. See server logs for details.',
      detail:  process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ─── URL parser (Jina Reader) ─────────────────────────────────────────────────

async function parseUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new ParseError('URL must start with http:// or https://', 400);
  }

  const jinaUrl = `${JINA_BASE}${url}`;
  let jinaRes;

  try {
    jinaRes = await fetchWithTimeout(jinaUrl, {
      headers: { Accept: 'text/markdown' },
    }, PARSE_TIMEOUT);
  } catch (err) {
    throw new ParseError(
      `Jina Reader fetch failed: ${err.message}. The URL may be unreachable or blocked.`,
      502,
    );
  }

  if (!jinaRes.ok) {
    throw new ParseError(
      `Jina Reader returned HTTP ${jinaRes.status} for ${url}. ` +
      'Ensure the URL is publicly accessible.',
      502,
    );
  }

  const raw = await jinaRes.text();
  if (!raw || raw.trim().length < 50) {
    throw new ParseError(
      'Jina Reader returned an empty or near-empty document. ' +
      'The page may require JavaScript rendering or authentication.',
      422,
    );
  }

  return {
    markdown: normalizeMarkdown(raw, url),
    method:   'jina-reader',
    source:   url,
  };
}

// ─── File parser (PDF → LlamaParse, DOCX → mammoth) ──────────────────────────

async function parseFile(fileBase64, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    return parsePdf(fileBase64, fileName);
  }
  if (ext === 'docx') {
    return parseDocx(fileBase64, fileName);
  }

  throw new ParseError(
    `Unsupported file type ".${ext}". Supported formats: .pdf, .docx`,
    415,
  );
}

// ── PDF via LlamaParse ────────────────────────────────────────────────────────

async function parsePdf(fileBase64, fileName) {
  if (!process.env.LLAMA_CLOUD_API_KEY) {
    throw new ParseError('Server misconfiguration: LLAMA_CLOUD_API_KEY not set.', 500);
  }

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    throw new ParseError('fileBase64 is not valid base64.', 400);
  }

  const client = new LlamaCloud({ apiKey: process.env.LLAMA_CLOUD_API_KEY });

  // Step 1: Upload the file to LlamaCloud
  let uploadedFile;
  try {
    uploadedFile = await withTimeout(
      client.files.create({
        file:    new File([buffer], fileName, { type: 'application/pdf' }),
        purpose: 'parse',
      }),
      PARSE_TIMEOUT,
      'LlamaParse upload timed out',
    );
  } catch (err) {
    throw new ParseError(
      `LlamaParse upload failed: ${err.message}. ` +
      'Check LLAMA_CLOUD_API_KEY validity and LlamaCloud status.',
      502,
    );
  }

  // Step 2: Parse the uploaded file (SDK handles polling internally)
  let result;
  try {
    result = await withTimeout(
      client.parsing.parse({
        file_id:  uploadedFile.id,
        tier:     'agentic',      // layout-aware: handles multi-column, tables, nested lists
        version:  'latest',
        expand:   ['markdown_full'],
      }),
      PARSE_TIMEOUT,
      'LlamaParse job timed out after 55 s. Try a smaller file or run ingestion locally.',
    );
  } catch (err) {
    throw new ParseError(`LlamaParse parsing failed: ${err.message}`, 502);
  }

  // `markdown_full` is a single concatenated string across all pages
  const raw = result?.markdown_full ?? result?.markdown?.pages?.map(p => p.markdown).join('\n\n') ?? '';

  if (!raw || raw.trim().length < 50) {
    throw new ParseError(
      'LlamaParse returned an empty document. ' +
      'The PDF may be image-only (scanned), password-protected, or corrupt.',
      422,
    );
  }

  return {
    markdown: normalizeMarkdown(raw, fileName),
    method:   'llamaparse-agentic',
    source:   fileName,
  };
}

// ── DOCX via mammoth ──────────────────────────────────────────────────────────

async function parseDocx(fileBase64, fileName) {
  let buffer;
  try {
    buffer = Buffer.from(fileBase64, 'base64');
  } catch {
    throw new ParseError('fileBase64 is not valid base64.', 400);
  }

  let mammothResult;
  try {
    mammothResult = await mammoth.convertToHtml(
      { buffer },
      {
        // Preserve heading structure from named styles
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
          "p[style-name='Title']     => h1:fresh",
          "p[style-name='Subtitle']  => h2:fresh",
        ],
      },
    );
  } catch (err) {
    throw new ParseError(
      `mammoth failed to parse "${fileName}": ${err.message}. ` +
      'Ensure the file is a valid .docx (not a renamed .doc or corrupt file).',
      422,
    );
  }

  if (mammothResult.messages.length > 0) {
    const warnings = mammothResult.messages
      .filter(m => m.type === 'warning')
      .map(m => m.message)
      .join('; ');
    if (warnings) console.warn(`[ingest/parse] mammoth warnings for ${fileName}: ${warnings}`);
  }

  const html = mammothResult.value;
  if (!html || html.trim().length < 50) {
    throw new ParseError(
      `"${fileName}" appears to be empty or contains no readable text.`,
      422,
    );
  }

  const raw = htmlToMarkdown(html);
  return {
    markdown: normalizeMarkdown(raw, fileName),
    method:   'mammoth-docx',
    source:   fileName,
  };
}

// ─── Post-processors ──────────────────────────────────────────────────────────

/**
 * Converts the basic HTML tags mammoth produces into Markdown.
 * Avoids a turndown dependency for a predictable, bounded tag set.
 */
function htmlToMarkdown(html) {
  return html
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n\n')
    // Inline emphasis
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi,           '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,         '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi,           '*$1*')
    // List items (before stripping list wrappers)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/?[ou]l[^>]*>/gi,           '\n')
    // Paragraphs and line breaks
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi,               '\n')
    // Tables — flatten to plain text rows separated by pipes
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, cells) => {
      const cellText = cells
        .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (__, c) => c.trim())
        .split('\n')
        .filter(Boolean)
        .join(' | ');
      return `| ${cellText} |\n`;
    })
    .replace(/<\/?table[^>]*>/gi, '\n')
    .replace(/<\/?thead[^>]*>/gi, '')
    .replace(/<\/?tbody[^>]*>/gi, '')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    // Collapse excess blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Structural post-processor applied to all three parse paths.
 *
 * Goals:
 *  1. Normalize line endings and collapse excessive blank lines
 *  2. Promote bare rule-number patterns to ## headers so the downstream
 *     chunker has reliable section boundaries
 *  3. Stamp the source file/URL at the top as an HTML comment
 *
 * The downstream chunker in embed-rules.cjs splits on #/## boundaries,
 * so preserving and adding them here is critical for retrieval quality.
 */
function normalizeMarkdown(raw, sourceName) {
  let md = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g,   '\n');

  // Promote bare rule-number lines that aren't already headers.
  // Matches patterns like:  "Rule 5.01"  "Section 3"  "Article IV"
  // "REGULATION VI"  "1.10"  "Fairness Doctrine" (ALL CAPS ≤ 50 chars)
  md = md.replace(
    /^(?!#)(\s*)(Rule\s+\d+[\.\d]*[a-z]?|Section\s+\d+|Article\s+[IVXLC]+|\d+\.\d+[a-z]?|[A-Z][A-Z\s]{2,48})\s*[-–—:]?\s*$/gim,
    '$1## $2\n',
  );

  // Collapse excessive blank lines introduced by replacements
  md = md.replace(/\n{3,}/g, '\n\n');

  // Stamp source at top for traceability
  const stamp = `<!-- ingested from: ${sourceName.replace(/-->/g, '->')} -->\n\n`;
  return (stamp + md).trim();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Wraps any Promise in a race against a timeout rejection.
 */
function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage ?? `Operation timed out after ${ms} ms`)), ms),
    ),
  ]);
}

/**
 * fetch() with a timeout, returns the Response.
 */
async function fetchWithTimeout(url, options = {}, ms = 30_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Structured error class that carries an HTTP status code.
 * Caught at the top level and serialized cleanly.
 */
class ParseError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name       = 'ParseError';
    this.statusCode = statusCode;
  }
}

// Override the generic catch in the main handler to respect ParseError status codes
const handlerWithStructuredErrors = async (req, res) => {
  try {
    return await handler(req, res);
  } catch (err) {
    if (err instanceof ParseError) {
      return res.status(err.statusCode).json({
        success: false,
        error:   err.message,
      });
    }
    console.error('[ingest/parse] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

export default withIngestAuth(handlerWithStructuredErrors);
