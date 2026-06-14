/**
 * lib/ingest/adapters/google-doc-ai.js
 *
 * Adapter for Google Cloud Document AI processDocument responses.
 *
 * Accepts:
 *   - Full ProcessResponse: { document: { text, pages, ... } }
 *   - Bare Document object: { text, pages, ... }
 *   - Batch wrapper: { responses: [{ document: ... }] }
 *
 * Returns normalized source_pages + source_blocks objects per base-adapter contract.
 */

import {
  BaseAdapter,
  AdapterError,
  BLOCK_ROLE,
  BLOCK_TYPE,
  clampConfidence,
  normalizeBbox,
  isNonEmptyText,
} from './base-adapter.js';

// ── Google Document AI helpers ────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function unwrapDocument(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new AdapterError('Payload is not an object', { code: 'INVALID_PAYLOAD' });
  }

  if (obj.document && typeof obj.document === 'object') {
    return /** @type {Record<string, unknown>} */ (obj.document);
  }

  if (Array.isArray(obj.responses) && obj.responses[0]?.document) {
    return /** @type {Record<string, unknown>} */ (obj.responses[0].document);
  }

  if (Array.isArray(obj.pages) || typeof obj.text === 'string') {
    return /** @type {Record<string, unknown>} */ (obj);
  }

  throw new AdapterError(
    'Unrecognized Google Document AI payload shape. Expected { document }, { text, pages }, or { responses: [...] }.',
    { code: 'UNRECOGNIZED_PAYLOAD' },
  );
}

/**
 * @param {string} documentText
 * @param {Record<string, unknown>|null|undefined} textAnchor
 * @returns {string}
 */
function textFromAnchor(documentText, textAnchor) {
  if (!textAnchor || !documentText) return '';

  const segments = textAnchor.textSegments ?? textAnchor.text_segments ?? [];
  if (!Array.isArray(segments) || segments.length === 0) return '';

  let out = '';
  for (const seg of segments) {
    const start = Number(seg.startIndex ?? seg.start_index ?? 0);
    const end   = Number(seg.endIndex ?? seg.end_index ?? documentText.length);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out += documentText.slice(start, end);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} layout
 * @returns {number|null}
 */
function layoutConfidence(layout) {
  return clampConfidence(layout?.confidence);
}

/**
 * @param {Record<string, unknown>} layout
 * @param {{ widthPt?: number|null, heightPt?: number|null }} pageCtx
 */
function layoutBbox(layout, pageCtx) {
  const poly = layout?.boundingPoly ?? layout?.bounding_poly;
  if (!poly) return null;
  return normalizeBbox(poly, {
    pageWidth:  pageCtx.widthPt ?? undefined,
    pageHeight: pageCtx.heightPt ?? undefined,
  });
}

/**
 * Heuristic role inference from Document AI block type + text content.
 *
 * @param {string} vendorKind — 'block' | 'paragraph' | 'line' | 'table' | 'visual'
 * @param {string} text
 * @param {Record<string, unknown>} [layout]
 * @returns {string}
 */
function inferRole(vendorKind, text, layout = {}) {
  const trimmed = text.trim();

  if (vendorKind === 'table') return BLOCK_ROLE.TABLE;
  if (vendorKind === 'visual') return BLOCK_ROLE.FIGURE;

  const detected = layout.detectedBreak?.type ?? layout.detected_break?.type;
  if (detected === 'PAGE_BREAK' || detected === 'page_break') {
    return BLOCK_ROLE.PAGE_BREAK;
  }

  // Rulebook-specific heading heuristics
  if (/^(?:rule|section|chapter|part)\s+\d{1,4}\b/i.test(trimmed)) {
    return BLOCK_ROLE.RULE_HEADING;
  }
  if (/^\d{1,4}[.)]\s+\S/.test(trimmed) && trimmed.length < 120) {
    return BLOCK_ROLE.SUBRULE_HEADING;
  }
  if (/^[A-Z][A-Z0-9\s\-]{2,}$/.test(trimmed) && trimmed.length < 80 && !trimmed.endsWith('.')) {
    return BLOCK_ROLE.CHAPTER_TITLE;
  }
  if (/^[-•*]\s+/.test(trimmed) || /^\([a-z]\)\s+/i.test(trimmed)) {
    return BLOCK_ROLE.LIST_ITEM;
  }
  if (/^note:/i.test(trimmed) || /^\*/.test(trimmed)) {
    return BLOCK_ROLE.FOOTNOTE;
  }

  if (vendorKind === 'block' && trimmed.length < 60 && !trimmed.endsWith('.')) {
    return BLOCK_ROLE.RULE_HEADING;
  }

  return BLOCK_ROLE.PARAGRAPH;
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} documentText
 * @param {string} vendorKind
 * @param {{ widthPt?: number|null, heightPt?: number|null }} pageCtx
 * @returns {{ exactText: string, role: string, confidence: number|null, bbox: ReturnType<typeof normalizeBbox>, charOffsetStart: number|null, charOffsetEnd: number|null, styleMetadata: Record<string, unknown> }|null}
 */
function elementToBlockFields(item, documentText, vendorKind, pageCtx) {
  const layout = item.layout ?? item;
  const anchor = layout.textAnchor ?? layout.text_anchor;
  const exactText = textFromAnchor(documentText, anchor);

  if (!isNonEmptyText(exactText)) return null;

  let charOffsetStart = null;
  let charOffsetEnd   = null;
  const segments = anchor?.textSegments ?? anchor?.text_segments ?? [];
  if (segments[0]) {
    charOffsetStart = Number(segments[0].startIndex ?? segments[0].start_index ?? 0);
    charOffsetEnd   = Number(segments[0].endIndex ?? segments[0].end_index ?? null);
    if (!Number.isFinite(charOffsetEnd)) charOffsetEnd = null;
  }

  const role = inferRole(vendorKind, exactText, layout);

  return {
    exactText: exactText.replace(/\r/g, ''),
    role,
    confidence: layoutConfidence(layout),
    bbox: layoutBbox(layout, pageCtx),
    charOffsetStart: Number.isFinite(charOffsetStart) ? charOffsetStart : null,
    charOffsetEnd,
    styleMetadata: {
      vendor: 'google-doc-ai',
      vendorKind,
      orientation: layout.orientation ?? null,
      detectedBreak: layout.detectedBreak ?? layout.detected_break ?? null,
    },
  };
}

/**
 * Flatten table body text from Document AI table structure.
 *
 * @param {Record<string, unknown>} table
 * @param {string} documentText
 * @returns {string}
 */
function tableToText(table, documentText) {
  const rows = [];
  const bodyRows = table.bodyRows ?? table.body_rows ?? [];
  for (const row of bodyRows) {
    const cells = row.cells ?? [];
    const cellTexts = cells.map(cell => {
      const layout = cell.layout ?? {};
      const anchor = layout.textAnchor ?? layout.text_anchor;
      return textFromAnchor(documentText, anchor).trim();
    }).filter(Boolean);
    if (cellTexts.length) rows.push(cellTexts.join('\t'));
  }
  return rows.join('\n').trim();
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class GoogleDocAiAdapter extends BaseAdapter {
  static vendorId     = 'google-doc-ai';
  static vendorFamily = 'google-document-ai';

  /**
   * @param {unknown} vendorPayload
   */
  validateVendorPayload(vendorPayload) {
    const doc = unwrapDocument(/** @type {Record<string, unknown>} */ (vendorPayload));
    if (!Array.isArray(doc.pages) || doc.pages.length === 0) {
      throw new AdapterError(
        'Google Document AI payload must include a non-empty pages array',
        { code: 'MISSING_PAGES' },
      );
    }
  }

  /**
   * @param {unknown} vendorPayload
   */
  parseVendorPayload(vendorPayload) {
    const doc = unwrapDocument(/** @type {Record<string, unknown>} */ (vendorPayload));
    const documentText = String(doc.text ?? '');
    const warnings = [];

    if (!isNonEmptyText(documentText)) {
      warnings.push('Document.text is empty; block text may be incomplete.');
    }

    const pages = doc.pages.map((page, idx) => {
      const pageNumber = Number(page.pageNumber ?? page.page_number ?? idx + 1);
      const dimension  = page.dimension ?? {};
      const widthPt    = Number(dimension.width ?? dimension.widthPt ?? null) || null;
      const heightPt   = Number(dimension.height ?? dimension.heightPt ?? null) || null;
      const pageCtx    = { widthPt, heightPt };

      /** @type {import('./types.js').NormalizedSourceBlock[]} */
      const blocks = [];
      let blockIndex = 0;

      const addElement = (item, vendorKind) => {
        const fields = elementToBlockFields(item, documentText, vendorKind, pageCtx);
        if (!fields) return;
        blocks.push({
          blockIndex: blockIndex++,
          role: fields.role,
          blockType: fields.role === BLOCK_ROLE.TABLE ? BLOCK_TYPE.TABLE : undefined,
          charOffsetStart: fields.charOffsetStart,
          charOffsetEnd: fields.charOffsetEnd,
          bbox: fields.bbox,
          exactText: fields.exactText,
          confidence: fields.confidence,
          styleMetadata: fields.styleMetadata,
        });
      };

      // Prefer paragraphs (best granularity for rulebooks); supplement with tables and visuals.
      const paragraphs = page.paragraphs ?? [];
      const tables     = page.tables ?? [];
      const visuals    = page.visualElements ?? page.visual_elements ?? [];

      if (paragraphs.length > 0) {
        for (const p of paragraphs) addElement(p, 'paragraph');
      } else {
        // Fall back to blocks, then lines
        const pageBlocks = page.blocks ?? [];
        if (pageBlocks.length > 0) {
          for (const b of pageBlocks) addElement(b, 'block');
        } else {
          const lines = page.lines ?? [];
          for (const line of lines) addElement(line, 'line');
          if (lines.length === 0) {
            warnings.push(`Page ${pageNumber}: no paragraphs, blocks, or lines found.`);
          }
        }
      }

      for (const table of tables) {
        const layout = table.layout ?? {};
        const tableText = tableToText(table, documentText)
          || textFromAnchor(documentText, layout.textAnchor ?? layout.text_anchor);
        if (!isNonEmptyText(tableText)) continue;
        blocks.push({
          blockIndex: blockIndex++,
          role: BLOCK_ROLE.TABLE,
          blockType: BLOCK_TYPE.TABLE,
          bbox: layoutBbox(layout, pageCtx),
          exactText: tableText.replace(/\r/g, ''),
          confidence: layoutConfidence(layout),
          styleMetadata: { vendor: 'google-doc-ai', vendorKind: 'table' },
        });
      }

      for (const visual of visuals) {
        addElement(visual, 'visual');
      }

      // Page raw text: concatenate block text in reading order
      const rawText = blocks.map(b => b.exactText).join('\n').trim()
        || documentText; // last resort

      const charStarts = blocks.map(b => b.charOffsetStart).filter(n => Number.isFinite(n));
      const charEnds   = blocks.map(b => b.charOffsetEnd).filter(n => Number.isFinite(n));

      return {
        pageNumber,
        charOffsetStart: charStarts.length ? Math.min(...charStarts) : null,
        charOffsetEnd:   charEnds.length ? Math.max(...charEnds) : null,
        widthPt,
        heightPt,
        rawText,
        layoutMetadata: {
          vendor: 'google-doc-ai',
          pageNumber,
          dimension,
          detectedLanguages: page.detectedLanguages ?? page.detected_languages ?? [],
          imageQualityScores: page.imageQualityScores ?? page.image_quality_scores ?? null,
        },
        blocks,
      };
    });

    return {
      pages,
      warnings,
      metadata: {
        mimeType: doc.mimeType ?? doc.mime_type ?? null,
        pageCount: pages.length,
        textLength: documentText.length,
        processorVersion: doc.revision ?? doc.revisions?.[0] ?? null,
      },
    };
  }
}

/**
 * Convenience factory matching the adapter contract.
 *
 * @param {string} rulebookId — rulebook_version_id UUID
 * @param {unknown} vendorPayload — Google Document AI JSON
 * @param {{ ruleDocumentId?: string|null, options?: Record<string, unknown> }} [opts]
 * @returns {import('./types.js').AdapterTransformResult}
 */
export function transformGoogleDocAi(rulebookId, vendorPayload, opts = {}) {
  const adapter = new GoogleDocAiAdapter({
    rulebookId,
    ruleDocumentId: opts.ruleDocumentId ?? null,
    options: opts.options ?? {},
  });
  return adapter.transform(vendorPayload);
}

export default GoogleDocAiAdapter;
