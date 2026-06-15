/**
 * lib/ingest/adapters/pdf-parse-blocks.js
 *
 * Deterministic PDF → NormalizedSourcePage[] adapter for the canonical graph
 * pipeline. Uses pdf-parse (pdfjs) page text and splits into paragraph blocks.
 */

import { PDFParse, VerbosityLevel } from 'pdf-parse';

const RULE_HEADING_3_RE  = /^(\d{3})[.:]\s+/;
const MLB_RULE_HEADING_RE = /^(\d{1,2}\.\d{2}[a-z]?)\s+/;
const SUBRULE_LETTER_RE  = /^([A-Z])[.)]\s+/;
const CHAPTER_LINE_RE    = /^[A-Z][A-Z0-9\s,'-]{6,}$/;

/**
 * @param {string} line
 * @returns {string|null}
 */
function inferBlockRole(line) {
  const trimmed = (line ?? '').trim();
  if (!trimmed) return null;
  if (RULE_HEADING_3_RE.test(trimmed)) return 'rule_heading';
  if (MLB_RULE_HEADING_RE.test(trimmed)) return 'rule_heading';
  if (SUBRULE_LETTER_RE.test(trimmed)) return 'subrule_heading';
  if (CHAPTER_LINE_RE.test(trimmed) && trimmed.length < 80) return 'chapter_title';
  if (/^PENALTY\b/i.test(trimmed)) return 'penalty';
  if (/^(?:note|comment)\b/i.test(trimmed)) return 'footnote';
  return 'paragraph';
}

/**
 * @param {string} pageText
 * @returns {string[]}
 */
function splitPageIntoParagraphs(pageText) {
  const normalized = (pageText ?? '').replace(/\r/g, '').trim();
  if (!normalized) return [];

  let parts = normalized
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);

  if (parts.length <= 1 && normalized.includes('\n')) {
    parts = normalized
      .split(/\n/)
      .map(l => l.trim())
      .filter(Boolean);
  }

  return parts.length ? parts : [normalized];
}

/**
 * @param {Buffer} buffer
 * @param {{ rulebookId: string, ruleDocumentId: string, filename?: string }} opts
 * @returns {Promise<import('./types.js').AdapterTransformResult>}
 */
export async function transformPdfToBlocks(buffer, opts) {
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

  /** @type {import('./types.js').NormalizedSourcePage[]} */
  const pages = [];
  let globalChar = 0;

  for (const page of result.pages ?? []) {
    const rawText = (page.text ?? '').replace(/\r/g, '').trim();
    if (!rawText) continue;

    const pageStart = globalChar;
    const paragraphs = splitPageIntoParagraphs(rawText);
    /** @type {import('./types.js').NormalizedSourceBlock[]} */
    const blocks = [];

    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i];
      const firstLine = text.split(/\s+/).length > 12
        ? text.slice(0, 120).split(/(?<=[.!?])\s+/)[0] ?? text.slice(0, 80)
        : text;
      const role = inferBlockRole(firstLine) ?? inferBlockRole(text.slice(0, 80));
      const isHeading = role === 'rule_heading' || role === 'chapter_title' || role === 'subrule_heading';

      const blockStart = globalChar;
      const blockEnd = blockStart + text.length;

      blocks.push({
        blockIndex:    i,
        role:          role ?? 'paragraph',
        blockType:     isHeading ? 'heading' : 'paragraph',
        charOffsetStart: blockStart,
        charOffsetEnd:   blockEnd,
        bbox:          { x: 0, y: i, width: 1, height: 1, coordinateSpace: 'normalized' },
        exactText:     text,
        confidence:    1,
        styleMetadata: { role: role ?? 'paragraph', source: 'pdf-parse-blocks' },
      });

      globalChar = blockEnd + 1;
    }

    pages.push({
      pageNumber:      page.num,
      charOffsetStart: pageStart,
      charOffsetEnd:   globalChar,
      widthPt:         null,
      heightPt:        null,
      rawText,
      layoutMetadata:  { parser: 'pdf-parse', filename: opts.filename ?? null },
      blocks,
    });

    globalChar += 1;
  }

  if (!pages.length) {
    throw new Error('pdf-parse-blocks: no text extracted from PDF (image-only or empty document).');
  }

  return {
    rulebookId:     opts.rulebookId,
    ruleDocumentId: opts.ruleDocumentId,
    vendor:         'pdf-parse',
    vendorAdapter:  'pdf-parse-blocks',
    pages,
    warnings:       [],
    metadata:       {
      pageCount: pages.length,
      blockCount: pages.reduce((n, p) => n + p.blocks.length, 0),
      filename: opts.filename ?? null,
    },
  };
}

export default { transformPdfToBlocks };
