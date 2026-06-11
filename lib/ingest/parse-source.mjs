/**
 * lib/ingest/parse-source.mjs
 *
 * Responsible for converting a raw source file (PDF, DOCX, TXT, URL, or
 * plain string) into a normalised list of SourceSpan objects.
 *
 * A SourceSpan represents a contiguous passage of text from the original
 * document, tagged with provenance metadata (page number, character offsets,
 * heading context). Downstream steps use SourceSpans as the unit of work —
 * rule-atom extraction, coverage verification, and Q&A retrieval all operate
 * on SourceSpans rather than on the raw bytes.
 *
 * Parsing strategy:
 *   PDF          → pdf-parse v2 (PDFParse) page-by-page extraction   ← IMPLEMENTED (Step 6a)
 *   DOCX         → mammoth extractRawText + paragraph segmentation    ← IMPLEMENTED (Step 6b)
 *   URL          → Jina Reader API r.jina.ai + paragraph segmentation ← IMPLEMENTED (Step 6b)
 *   TXT / HTML   → line/paragraph segmentation                        ← stub (future)
 *
 * @typedef {Object} SourceSpan
 * @property {number}  seq         - Zero-based sequence number within the document.
 * @property {string}  text        - Verbatim text of the span (trimmed, never empty).
 * @property {string}  [heading]   - Nearest section heading above this span, if any.
 * @property {number}  [page]      - Page number (1-based) where the span begins.
 * @property {number}  [charStart] - Character offset within the full document text.
 * @property {number}  [charEnd]   - Character offset (exclusive) within the full document text.
 * @property {string}  [sourceUrl] - Origin URL if the source is a remote resource.
 */

import { readFile }               from 'node:fs/promises';
import { extname }                from 'node:path';
import { PDFParse, VerbosityLevel } from 'pdf-parse';
import mammoth                    from 'mammoth';

/**
 * Infer MIME type from a file extension.
 * @param {string|undefined} filePath
 * @returns {string|null}
 */
function inferMime(filePath) {
  if (!filePath) return null;
  switch (extname(filePath).toLowerCase()) {
    case '.pdf':  return 'application/pdf';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.txt':  return 'text/plain';
    case '.html':
    case '.htm':  return 'text/html';
    default:      return null;
  }
}

/**
 * Parse a PDF Buffer into an array of SourceSpans, one span per non-empty page.
 *
 * Uses pdf-parse v2 (PDFParse) which wraps pdfjs-dist.  Text extraction is
 * deterministic: the page text comes from the PDF's content streams, not from
 * any AI model.
 *
 * @param {Buffer} buffer
 * @returns {Promise<SourceSpan[]>}
 * @throws {Error} If no text can be extracted (e.g. image-only PDF).
 */
async function parsePdf(buffer) {
  const parser = new PDFParse({
    data:      new Uint8Array(buffer),
    verbosity: VerbosityLevel.ERRORS,
  });

  let result;
  try {
    result = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const spans = [];
  let seq        = 0;
  let charOffset = 0;

  for (const page of result.pages) {
    const text = (page.text ?? '').trim();
    if (!text) continue;

    spans.push({
      seq,
      text,
      heading:   null,
      page:      page.num,
      charStart: charOffset,
      charEnd:   charOffset + text.length,
    });

    seq++;
    charOffset += text.length + 1; // +1 for implicit separator
  }

  if (spans.length === 0) {
    throw new Error(
      'parsePdf: no text could be extracted — PDF may be image-based or have no selectable text.',
    );
  }

  return spans;
}

// Minimum paragraph length in characters — shorter paragraphs (e.g. lone
// section numbers, page footers) are merged into their successor.
const MIN_PARA_CHARS = 20;

/**
 * Split a block of text into non-trivial paragraphs.
 *
 * Paragraphs are separated by one or more blank lines.  Very short fragments
 * (below MIN_PARA_CHARS) are prepended to the next paragraph so that section
 * headings stay attached to the body text that follows them.
 *
 * @param {string} text
 * @returns {string[]} Non-empty, trimmed paragraph strings.
 */
function splitParagraphs(text) {
  const raw = text.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);

  const merged = [];
  let pending   = '';

  for (const para of raw) {
    if (pending) {
      merged.push(`${pending} ${para}`);
      pending = '';
    } else if (para.length < MIN_PARA_CHARS) {
      // Short fragment — hold it to prepend to next paragraph.
      pending = para;
    } else {
      merged.push(para);
    }
  }

  if (pending) merged.push(pending); // trailing short fragment

  return merged.filter(p => p.length > 0);
}

/**
 * Parse a DOCX Buffer into an array of SourceSpans using mammoth's
 * `extractRawText` method.
 *
 * mammoth does not track page boundaries, so all spans carry `page: 1`.
 * Paragraphs are segmented by blank lines in mammoth's raw text output.
 *
 * @param {Buffer} buffer
 * @returns {Promise<SourceSpan[]>}
 * @throws {Error} If mammoth cannot parse the buffer or finds no text.
 */
async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });

  if (result.messages && result.messages.length > 0) {
    const warnings = result.messages.filter(m => m.type === 'warning');
    if (warnings.length > 0) {
      console.warn(`[parseDocx] ${warnings.length} mammoth warning(s):`, warnings[0].message);
    }
  }

  const fullText = result.value ?? '';
  if (!fullText.trim()) {
    throw new Error('parseDocx: mammoth returned empty text — DOCX may have no body content.');
  }

  const paragraphs = splitParagraphs(fullText);
  if (paragraphs.length === 0) {
    throw new Error('parseDocx: no non-empty paragraphs found after splitting DOCX text.');
  }

  let charOffset = 0;
  return paragraphs.map((text, i) => {
    const span = {
      seq:       i,
      text,
      heading:   null,  // heading detection deferred to Step 10
      page:      1,     // mammoth does not expose page breaks
      charStart: charOffset,
      charEnd:   charOffset + text.length,
    };
    charOffset += text.length + 1;
    return span;
  });
}

/** Jina Reader base URL — converts any web page to clean markdown. */
const JINA_BASE     = 'https://r.jina.ai/';
const URL_TIMEOUT_MS = 30_000;

/**
 * Fetch a URL via the Jina Reader API and parse it into SourceSpans.
 *
 * Jina Reader (r.jina.ai) accepts any public URL and returns clean markdown
 * text, stripping navigation, ads, and boilerplate.  No API key is required
 * for basic use.
 *
 * The function uses globalThis.fetch so tests can override it without any spy
 * library — just replace globalThis.fetch before calling parseSource().
 *
 * @param {string} url          - The original league rulebook URL to fetch.
 * @param {number} [timeoutMs]  - Abort timeout in ms. Defaults to URL_TIMEOUT_MS.
 * @returns {Promise<SourceSpan[]>}
 * @throws {Error} On network failure, timeout, non-200 response, or empty content.
 */
async function parseUrl(url, timeoutMs = URL_TIMEOUT_MS) {
  const jinaUrl    = JINA_BASE + url;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await globalThis.fetch(jinaUrl, {
      signal:  controller.signal,
      headers: { Accept: 'text/plain,text/markdown' },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`parseUrl: request timed out after ${timeoutMs}ms fetching ${url}`);
    }
    throw new Error(`parseUrl: network error fetching ${url} — ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `parseUrl: HTTP ${response.status} from Jina Reader for ${url}`,
    );
  }

  const markdown = await response.text();
  if (!markdown.trim()) {
    throw new Error(`parseUrl: Jina Reader returned empty content for ${url}`);
  }

  const paragraphs = splitParagraphs(markdown);
  if (paragraphs.length === 0) {
    throw new Error(`parseUrl: no usable paragraphs found in content from ${url}`);
  }

  let charOffset = 0;
  return paragraphs.map((text, i) => {
    const span = {
      seq:       i,
      text,
      heading:   null,
      page:      null,
      charStart: charOffset,
      charEnd:   charOffset + text.length,
      sourceUrl: url,
    };
    charOffset += text.length + 1;
    return span;
  });
}

/**
 * Parse a source file or string into an ordered array of SourceSpans.
 *
 * @param {Object}         opts
 * @param {Buffer}         [opts.buffer]    - Raw file bytes. Requires opts.mimeType when not
 *                                           inferrable from opts.filePath.
 * @param {string}         [opts.filePath]  - Absolute path to a local file (PDF, DOCX, TXT).
 * @param {string}         [opts.url]       - Remote URL to fetch via Jina Reader and parse.
 * @param {string}         [opts.text]      - Raw text string to parse directly.
 * @param {string}         [opts.mimeType]  - MIME type override. Inferred from extension when omitted.
 * @param {number}         [opts.timeoutMs] - Fetch timeout for URL requests (default 30 s).
 * @returns {Promise<SourceSpan[]>}         Ordered, non-empty array of SourceSpans.
 * @throws {Error}  If no source is provided or the source cannot be parsed.
 */
export async function parseSource(opts = {}) {
  if (!opts.buffer && !opts.filePath && !opts.url && !opts.text) {
    throw new Error(
      'parseSource: at least one of buffer, filePath, url, or text must be provided.',
    );
  }

  const mime = opts.mimeType ?? inferMime(opts.filePath);

  // ── PDF ───────────────────────────────────────────────────────────────────
  if (mime === 'application/pdf') {
    const buf = opts.buffer ?? await readFile(opts.filePath);
    return parsePdf(buf);
  }

  // ── DOCX ─────────────────────────────────────────────────────────────────
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (mime === DOCX_MIME) {
    const buf = opts.buffer ?? await readFile(opts.filePath);
    return parseDocx(buf);
  }

  // ── buffer with no recognized mime — default to PDF ──────────────────────
  if (opts.buffer instanceof Buffer) {
    return parsePdf(opts.buffer);
  }

  // ── URL via Jina Reader ───────────────────────────────────────────────────
  if (opts.url) {
    return parseUrl(opts.url, opts.timeoutMs);
  }

  // ── Plain text — pass-through ─────────────────────────────────────────────
  return [
    {
      seq:       0,
      text:      opts.text,
      heading:   null,
      page:      null,
      charStart: 0,
      charEnd:   opts.text.length,
    },
  ];
}
