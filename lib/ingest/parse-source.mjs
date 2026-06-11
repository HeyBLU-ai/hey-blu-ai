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
 *   TXT / HTML   → line/paragraph segmentation                        ← stub (Step 6b)
 *   DOCX         → mammoth text extraction then paragraph segmentation ← stub (Step 6b)
 *   URL          → fetch + HTML-to-text then paragraph segmentation   ← stub (Step 6b)
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

import { readFile } from 'node:fs/promises';
import { extname }  from 'node:path';
import { PDFParse, VerbosityLevel } from 'pdf-parse';

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

/**
 * Parse a source file or string into an ordered array of SourceSpans.
 *
 * @param {Object}         opts
 * @param {Buffer}         [opts.buffer]    - Raw file bytes (PDF only for now).
 * @param {string}         [opts.filePath]  - Absolute path to a local file (PDF, DOCX, TXT).
 * @param {string}         [opts.url]       - Remote URL to fetch and parse as HTML/text.
 * @param {string}         [opts.text]      - Raw text string to parse directly.
 * @param {string}         [opts.mimeType]  - MIME type override. Inferred from extension when omitted.
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

  // ── PDF path ──────────────────────────────────────────────────────────────
  if (opts.buffer instanceof Buffer || mime === 'application/pdf') {
    const buf = opts.buffer ?? await readFile(opts.filePath);
    return parsePdf(buf);
  }

  // ── filePath (non-PDF) — stub until Step 6b ───────────────────────────────
  if (opts.filePath) {
    return [
      {
        seq:       0,
        text:      '(stub — non-PDF filePath parsing not yet implemented)',
        heading:   null,
        page:      null,
        charStart: 0,
        charEnd:   0,
      },
    ];
  }

  // ── URL — stub until Step 6b ──────────────────────────────────────────────
  if (opts.url) {
    return [
      {
        seq:       0,
        text:      '(stub — URL parsing not yet implemented)',
        heading:   null,
        page:      null,
        charStart: 0,
        charEnd:   0,
      },
    ];
  }

  // ── Plain text — stub until Step 6b ──────────────────────────────────────
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
