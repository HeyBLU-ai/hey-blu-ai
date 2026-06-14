/**
 * JSDoc type definitions for vendor extraction adapters.
 */

/**
 * @typedef {Object} NormalizedBbox
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {'normalized'|'points'} coordinateSpace
 */

/**
 * @typedef {Object} NormalizedSourceBlock
 * @property {number} blockIndex
 * @property {string} role — BLOCK_ROLE value
 * @property {string} blockType — BLOCK_TYPE value (source_blocks.block_type)
 * @property {number|null} [charOffsetStart]
 * @property {number|null} [charOffsetEnd]
 * @property {NormalizedBbox|null} [bbox]
 * @property {string} exactText — source_blocks.exact_text
 * @property {number|null} confidence — 0..1 OCR/layout confidence
 * @property {Record<string, unknown>} [styleMetadata] — source_blocks.style_metadata
 */

/**
 * @typedef {Object} NormalizedSourcePage
 * @property {number} pageNumber — source_pages.page_number (1-based)
 * @property {number|null} [charOffsetStart] — source_pages.char_offset_start
 * @property {number|null} [charOffsetEnd] — source_pages.char_offset_end
 * @property {number|null} [widthPt] — source_pages.width_pt
 * @property {number|null} [heightPt] — source_pages.height_pt
 * @property {string} rawText — source_pages.raw_text
 * @property {Record<string, unknown>} [layoutMetadata] — source_pages.layout_metadata
 * @property {NormalizedSourceBlock[]} blocks
 */

/**
 * @typedef {Object} AdapterTransformResult
 * @property {string} rulebookId — rulebook_version_id UUID
 * @property {string|null} ruleDocumentId — rule_documents.id when known
 * @property {string} vendor — vendor family label
 * @property {string} vendorAdapter — adapter module id
 * @property {NormalizedSourcePage[]} pages
 * @property {string[]} warnings
 * @property {Record<string, unknown>} metadata
 */

export {};
