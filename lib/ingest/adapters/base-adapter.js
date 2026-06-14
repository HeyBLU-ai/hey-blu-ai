/**
 * lib/ingest/adapters/base-adapter.js
 *
 * Vendor-neutral contract for extraction adapters.
 *
 * Every adapter accepts an arbitrary vendor JSON payload plus a rulebook_id
 * (rulebook_version_id UUID) and returns normalized objects shaped for
 * source_pages and source_blocks persistence — without writing to the DB.
 *
 * Subclasses implement parseVendorPayload(). The base class enforces
 * validation, bbox normalization, role→block_type mapping, and confidence bounds.
 */

// ── Role enum (vendor-neutral semantic role) ─────────────────────────────────

/** @readonly */
export const BLOCK_ROLE = Object.freeze({
  CHAPTER_TITLE:   'chapter_title',
  RULE_HEADING:    'rule_heading',
  SUBRULE_HEADING: 'subrule_heading',
  PARAGRAPH:       'paragraph',
  LIST_ITEM:       'list_item',
  TABLE:           'table',
  FOOTNOTE:        'footnote',
  CAPTION:         'caption',
  FIGURE:          'figure',
  PAGE_BREAK:      'page_break',
  HEADER:          'header',
  FOOTER:          'footer',
  OTHER:           'other',
});

// ── DB block_type enum (source_blocks.block_type CHECK constraint) ────────────

/** @readonly */
export const BLOCK_TYPE = Object.freeze({
  HEADING:    'heading',
  PARAGRAPH:  'paragraph',
  LIST_ITEM:  'list_item',
  TABLE:      'table',
  FOOTNOTE:   'footnote',
  CAPTION:    'caption',
  IMAGE:      'image',
  PAGE_BREAK: 'page_break',
  OTHER:      'other',
});

/** Maps semantic role → source_blocks.block_type */
export const ROLE_TO_BLOCK_TYPE = Object.freeze({
  [BLOCK_ROLE.CHAPTER_TITLE]:   BLOCK_TYPE.HEADING,
  [BLOCK_ROLE.RULE_HEADING]:    BLOCK_TYPE.HEADING,
  [BLOCK_ROLE.SUBRULE_HEADING]: BLOCK_TYPE.HEADING,
  [BLOCK_ROLE.PARAGRAPH]:       BLOCK_TYPE.PARAGRAPH,
  [BLOCK_ROLE.LIST_ITEM]:       BLOCK_TYPE.LIST_ITEM,
  [BLOCK_ROLE.TABLE]:           BLOCK_TYPE.TABLE,
  [BLOCK_ROLE.FOOTNOTE]:        BLOCK_TYPE.FOOTNOTE,
  [BLOCK_ROLE.CAPTION]:         BLOCK_TYPE.CAPTION,
  [BLOCK_ROLE.FIGURE]:          BLOCK_TYPE.IMAGE,
  [BLOCK_ROLE.PAGE_BREAK]:      BLOCK_TYPE.PAGE_BREAK,
  [BLOCK_ROLE.HEADER]:          BLOCK_TYPE.OTHER,
  [BLOCK_ROLE.FOOTER]:          BLOCK_TYPE.OTHER,
  [BLOCK_ROLE.OTHER]:           BLOCK_TYPE.OTHER,
});

// ── Errors ───────────────────────────────────────────────────────────────────

export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: unknown }} [opts]
   */
  constructor(message, { code = 'ADAPTER_ERROR', details = null } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Clamp confidence to [0, 1]. Returns null when input is not a finite number.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function clampConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalize a vendor bounding box to HeyBLU canonical form:
 * { x, y, width, height, coordinateSpace: 'normalized' | 'points' }
 *
 * Accepts Google Document AI boundingPoly (normalizedVertices or vertices),
 * Adobe-style polygon arrays, or pre-normalized {x,y,width,height} objects.
 *
 * @param {unknown} input
 * @param {{ pageWidth?: number, pageHeight?: number }} [ctx]
 * @returns {import('./types.js').NormalizedBbox|null}
 */
export function normalizeBbox(input, { pageWidth, pageHeight } = {}) {
  if (!input || typeof input !== 'object') return null;

  // Already canonical
  if (
    Number.isFinite(input.x) &&
    Number.isFinite(input.y) &&
    Number.isFinite(input.width) &&
    Number.isFinite(input.height)
  ) {
    return {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      coordinateSpace: input.coordinateSpace === 'points' ? 'points' : 'normalized',
    };
  }

  const poly = input.boundingPoly ?? input.bounding_poly ?? input;
  const normVerts = poly.normalizedVertices ?? poly.normalized_vertices;
  const verts     = poly.vertices ?? poly;

  const points = Array.isArray(normVerts) && normVerts.length
    ? normVerts
    : (Array.isArray(verts) && verts.length ? verts : null);

  if (!points?.length) return null;

  const xs = points.map(v => Number(v.x ?? 0));
  const ys = points.map(v => Number(v.y ?? 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const isNormalized = Array.isArray(normVerts) && normVerts.length > 0;
  if (isNormalized) {
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      coordinateSpace: 'normalized',
    };
  }

  // Absolute vertices — convert to points if page dimensions known
  if (pageWidth && pageHeight) {
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      coordinateSpace: 'points',
    };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    coordinateSpace: 'points',
  };
}

/**
 * @param {string} role
 * @returns {string}
 */
export function roleToBlockType(role) {
  return ROLE_TO_BLOCK_TYPE[role] ?? BLOCK_TYPE.OTHER;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isNonEmptyText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

// ── Base adapter ───────────────────────────────────────────────────────────────

/**
 * @typedef {import('./types.js').AdapterTransformResult} AdapterTransformResult
 * @typedef {import('./types.js').NormalizedSourcePage} NormalizedSourcePage
 * @typedef {import('./types.js').NormalizedSourceBlock} NormalizedSourceBlock
 */

export class BaseAdapter {
  /** @type {string} Override in subclass — e.g. 'google-doc-ai' */
  static vendorId = 'base';

  /** @type {string} Human-readable vendor family */
  static vendorFamily = 'unknown';

  /**
   * @param {{ rulebookId: string, ruleDocumentId?: string|null, options?: Record<string, unknown> }} config
   */
  constructor({ rulebookId, ruleDocumentId = null, options = {} }) {
    if (!rulebookId || typeof rulebookId !== 'string') {
      throw new AdapterError('rulebookId is required', { code: 'INVALID_RULEBOOK_ID' });
    }
    this.rulebookId     = rulebookId;
    this.ruleDocumentId = ruleDocumentId;
    this.options        = options;
  }

  /**
   * Public entry point. Subclasses should not override unless extending validation.
   *
   * @param {unknown} vendorPayload — raw vendor JSON (object)
   * @returns {AdapterTransformResult}
   */
  transform(vendorPayload) {
    if (!vendorPayload || typeof vendorPayload !== 'object') {
      throw new AdapterError('vendorPayload must be a non-null object', { code: 'INVALID_PAYLOAD' });
    }

    this.validateVendorPayload(vendorPayload);

    const raw = this.parseVendorPayload(vendorPayload);
    const result = this.buildResult(raw);

    this.validateResult(result);
    return result;
  }

  /**
   * Vendor-specific structural checks before parsing.
   * Override in subclass.
   *
   * @param {unknown} _vendorPayload
   */
  validateVendorPayload(_vendorPayload) {
    // default: no-op
  }

  /**
   * Vendor-specific parsing. Must return { pages, warnings?, metadata? }.
   * Override in subclass.
   *
   * @param {unknown} _vendorPayload
   * @returns {{ pages: NormalizedSourcePage[], warnings?: string[], metadata?: Record<string, unknown> }}
   */
  parseVendorPayload(_vendorPayload) {
    throw new AdapterError(
      `${this.constructor.name} must implement parseVendorPayload()`,
      { code: 'NOT_IMPLEMENTED' },
    );
  }

  /**
   * @param {{ pages: NormalizedSourcePage[], warnings?: string[], metadata?: Record<string, unknown> }} raw
   * @returns {AdapterTransformResult}
   */
  buildResult(raw) {
    const warnings = [...(raw.warnings ?? [])];
    const pages = [];

    for (const [pageIdx, page] of (raw.pages ?? []).entries()) {
      try {
        pages.push(this.normalizePage(page, pageIdx));
      } catch (err) {
        if (err instanceof AdapterError && (err.code === 'NO_BLOCKS' || err.code === 'EMPTY_PAGE_TEXT')) {
          warnings.push(`Skipped page ${page.pageNumber ?? pageIdx + 1}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    return {
      rulebookId:     this.rulebookId,
      ruleDocumentId: this.ruleDocumentId,
      vendor:         this.constructor.vendorFamily,
      vendorAdapter:  this.constructor.vendorId,
      pages,
      warnings,
      metadata: {
        adapterVersion: '1.0.0',
        ...(raw.metadata ?? {}),
      },
    };
  }

  /**
   * @param {NormalizedSourcePage} page
   * @param {number} pageIdx
   * @returns {NormalizedSourcePage}
   */
  normalizePage(page, pageIdx) {
    const pageNumber = Number(page.pageNumber ?? pageIdx + 1);
    const rawText    = String(page.rawText ?? '').replace(/\r/g, '');

    if (!isNonEmptyText(rawText)) {
      throw new AdapterError(
        `Page ${pageNumber} has empty rawText`,
        { code: 'EMPTY_PAGE_TEXT', details: { pageNumber } },
      );
    }

    const blocks = (page.blocks ?? [])
      .map((block, blockIdx) => this.normalizeBlock(block, blockIdx, page))
      .filter(Boolean);

    if (blocks.length === 0) {
      throw new AdapterError(
        `Page ${pageNumber} produced zero blocks`,
        { code: 'NO_BLOCKS', details: { pageNumber } },
      );
    }

    return {
      pageNumber,
      charOffsetStart: page.charOffsetStart ?? null,
      charOffsetEnd:   page.charOffsetEnd ?? null,
      widthPt:         page.widthPt ?? null,
      heightPt:        page.heightPt ?? null,
      rawText,
      layoutMetadata:  page.layoutMetadata ?? {},
      blocks,
    };
  }

  /**
   * @param {NormalizedSourceBlock} block
   * @param {number} blockIdx
   * @param {NormalizedSourcePage} page
   * @returns {NormalizedSourceBlock|null}
   */
  normalizeBlock(block, blockIdx, page) {
    const exactText = String(block.exactText ?? '').replace(/\r/g, '');
    if (!isNonEmptyText(exactText)) return null;

    const role      = block.role ?? BLOCK_ROLE.OTHER;
    const blockType = block.blockType ?? roleToBlockType(role);
    const confidence = clampConfidence(block.confidence);

    const pageWidth  = page.widthPt ?? undefined;
    const pageHeight = page.heightPt ?? undefined;
    const bbox       = block.bbox ? normalizeBbox(block.bbox, { pageWidth, pageHeight }) : null;

    return {
      blockIndex:      Number.isFinite(block.blockIndex) ? block.blockIndex : blockIdx,
      role,
      blockType,
      charOffsetStart: block.charOffsetStart ?? null,
      charOffsetEnd:   block.charOffsetEnd ?? null,
      bbox,
      exactText,
      confidence,
      styleMetadata: {
        ...(block.styleMetadata ?? {}),
        role,
        confidence,
      },
    };
  }

  /**
   * @param {AdapterTransformResult} result
   */
  validateResult(result) {
    if (!result.pages?.length) {
      throw new AdapterError('Adapter produced zero pages', { code: 'EMPTY_RESULT' });
    }

    for (const page of result.pages) {
      if (page.pageNumber < 1) {
        throw new AdapterError('pageNumber must be >= 1', { code: 'INVALID_PAGE_NUMBER' });
      }
      for (const block of page.blocks) {
        if (!Object.values(BLOCK_TYPE).includes(block.blockType)) {
          throw new AdapterError(
            `Invalid blockType "${block.blockType}"`,
            { code: 'INVALID_BLOCK_TYPE', details: { blockType: block.blockType } },
          );
        }
        if (!Object.values(BLOCK_ROLE).includes(block.role)) {
          throw new AdapterError(
            `Invalid role "${block.role}"`,
            { code: 'INVALID_ROLE', details: { role: block.role } },
          );
        }
        if (block.confidence !== null && (block.confidence < 0 || block.confidence > 1)) {
          throw new AdapterError(
            `confidence out of range: ${block.confidence}`,
            { code: 'INVALID_CONFIDENCE' },
          );
        }
      }
    }
  }
}

export default BaseAdapter;
