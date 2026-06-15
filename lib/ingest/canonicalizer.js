/**
 * lib/ingest/canonicalizer.js
 *
 * Deterministic state machine: linear source_blocks → hierarchical rule_nodes.
 * Reads blocks in page + reading order (bbox.y, block_index) and assigns
 * body paragraphs to the active heading node until the next heading.
 */

// ── Heading patterns (deterministic) ─────────────────────────────────────────

const RULE_HEADING_RE   = /^(\d{3})[.:]\s+(.+)$/s;
const MLB_RULE_HEADING_RE = /^(\d{1,2}\.\d{2}[a-z]?)\s*[-—:.]?\s*(.+)$/s;
const SUBRULE_LETTER_RE = /^([A-Z])[.)]\s+(.+)$/s;
const SUBRULE_NUM_RE    = /^(\d{1,2})[.)]\s+(.+)$/s;
const PENALTY_RE        = /^PENALTY\b/i;
const NOTE_RE           = /^(?:note|comment)\b/i;

const BODY_BLOCK_TYPES = new Set(['paragraph', 'list_item', 'footnote', 'other']);
const HEADING_BLOCK_TYPES = new Set(['heading']);

/**
 * @typedef {Object} SourceBlockRow
 * @property {string} id
 * @property {string} extraction_run_id
 * @property {string} source_page_id
 * @property {number} block_index
 * @property {string} block_type
 * @property {number|null} char_offset_start
 * @property {number|null} char_offset_end
 * @property {Object|null} bbox
 * @property {string} exact_text
 * @property {Object} style_metadata
 * @property {number} page_number
 * @property {number|null} read_y
 */

/**
 * @typedef {Object} CanonicalNode
 * @property {string} node_key
 * @property {string} node_type
 * @property {string|null} rule_number
 * @property {string|null} title
 * @property {string} body_text
 * @property {number} sort_order
 * @property {number} depth
 * @property {string|null} parent_key
 * @property {number|null} page_start
 * @property {number|null} page_end
 * @property {number|null} char_start
 * @property {number|null} char_end
 * @property {string[]} source_block_ids
 * @property {Object} metadata
 */

/**
 * @typedef {Object} CanonicalChunk
 * @property {string} node_key
 * @property {number} chunk_index
 * @property {string} chunk_text
 * @property {number|null} char_start
 * @property {number|null} char_end
 * @property {string[]} source_block_ids
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
  return (text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * First non-empty line of a block.
 *
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  return cleanText(text).split('\n').find(l => l.trim())?.trim() ?? '';
}

/**
 * TOC lines on early pages are short single-line rule references without body.
 *
 * @param {string} text
 * @param {number} pageNumber
 * @returns {boolean}
 */
export function isTocHeading(text, pageNumber) {
  if (pageNumber > 3) return false;
  const line = firstLine(text);
  if (!RULE_HEADING_RE.test(line)) return false;
  // TOC entries are compact single-line references without rule body on the same block.
  if (text.includes('\n\n')) return false;
  if (line.length > 100) return false;
  return true;
}

/**
 * Classify a block as a structural heading using regex + adapter metadata.
 *
 * @param {SourceBlockRow} block
 * @returns {{ nodeType: string, ruleNumber: string|null, title: string, subKey?: string }|null}
 */
export function classifyHeading(block) {
  const text  = cleanText(block.exact_text);
  const line  = firstLine(text);
  const role  = block.style_metadata?.role ?? null;
  const isHeadingType = HEADING_BLOCK_TYPES.has(block.block_type)
    || role === 'rule_heading'
    || role === 'subrule_heading'
    || role === 'chapter_title';

  if (isTocHeading(text, block.page_number)) return null;

  const ruleMatch = line.match(RULE_HEADING_RE);
  if (ruleMatch) {
    const ruleNumber = ruleMatch[1];
    const title = cleanText(ruleMatch[2])
      .replace(/\s*\(revised\s+[^)]+\)\s*/gi, '')
      .replace(/\s*\(adopted\s+[^)]+\)\s*/gi, '')
      .trim();

    const titleUpper = title.replace(/[^A-Za-z]/g, '');
    const isChapter = title.length > 8
      && title === title.toUpperCase()
      && /[A-Z]{2,}/.test(title)
      && (isHeadingType || line.length < 120);

    if (isChapter) {
      return { nodeType: 'chapter', ruleNumber, title };
    }

    if (isHeadingType || role === 'rule_heading' || line.length < 160) {
      return { nodeType: 'rule', ruleNumber, title };
    }
  }

  const mlbMatch = line.match(MLB_RULE_HEADING_RE);
  if (mlbMatch) {
    const ruleNumber = mlbMatch[1];
    const title = cleanText(mlbMatch[2]).trim();
    if (isHeadingType || role === 'rule_heading' || line.length < 200) {
      return { nodeType: 'rule', ruleNumber, title: title || `Rule ${ruleNumber}` };
    }
  }

  const letterMatch = line.match(SUBRULE_LETTER_RE);
  if (letterMatch && (isHeadingType || role === 'subrule_heading' || line.length < 200)) {
    return {
      nodeType: 'subrule',
      ruleNumber: null,
      title: cleanText(letterMatch[2]),
      subKey: letterMatch[1],
    };
  }

  const numMatch = line.match(SUBRULE_NUM_RE);
  if (numMatch && (isHeadingType || line.length < 100)) {
    return {
      nodeType: 'subrule',
      ruleNumber: null,
      title: cleanText(numMatch[2]),
      subKey: numMatch[1],
    };
  }

  if (PENALTY_RE.test(line)) {
    return { nodeType: 'penalty', ruleNumber: null, title: line.slice(0, 120) };
  }

  if (NOTE_RE.test(line) || role === 'footnote') {
    return { nodeType: 'comment', ruleNumber: null, title: line.slice(0, 120) };
  }

  return null;
}

/**
 * @param {SourceBlockRow} block
 * @returns {boolean}
 */
export function isBodyBlock(block) {
  if (BODY_BLOCK_TYPES.has(block.block_type)) return true;
  const role = block.style_metadata?.role;
  return role === 'paragraph' || role === 'list_item' || role === 'footnote';
}

/**
 * @typedef {Object} CanonicalWarning
 * @property {string} warning_code
 * @property {string} message
 * @property {string} [severity]
 * @property {boolean} [is_blocking]
 * @property {string|null} [node_key]
 * @property {string|null} [source_block_id]
 * @property {string|null} [source_page_id]
 * @property {Object} [details]
 */

/** @type {number} */
const SHORT_BODY_THRESHOLD = 20;

/**
 * @param {CanonicalWarning[]} warnings
 * @param {Partial<CanonicalWarning> & Pick<CanonicalWarning, 'warning_code'|'message'>} partial
 */
function addWarning(warnings, partial) {
  warnings.push({
    severity: 'warning',
    is_blocking: false,
    node_key: null,
    source_block_id: null,
    source_page_id: null,
    details: {},
    ...partial,
  });
}

/**
 * @param {string} nodeType
 * @param {string} keyPart
 * @param {Map<string, number>} seen
 * @returns {string}
 */
function uniqueNodeKey(nodeType, keyPart, seen) {
  const base = `${nodeType}:${keyPart}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n + 1}`;
}

/**
 * Run the canonicalization state machine over ordered blocks.
 *
 * @param {SourceBlockRow[]} blocks — pre-sorted reading order
 * @returns {{ nodes: CanonicalNode[], chunks: CanonicalChunk[], warnings: CanonicalWarning[] }}
 */
export function canonicalizeBlocks(blocks) {
  /** @type {CanonicalNode[]} */
  const nodes = [];
  /** @type {CanonicalChunk[]} */
  const chunks = [];
  const warnings = [];
  const keySeen = new Map();

  /** @type {CanonicalNode|null} */
  let currentChapter = null;
  /** @type {CanonicalNode|null} */
  let currentRule = null;
  /** @type {CanonicalNode|null} */
  let currentNode = null;
  let sortOrder = 0;
  const ruleBodies = new Map();
  /** @type {Map<string, CanonicalNode>} */
  const ruleNodeByNumber = new Map();

  /**
   * @param {CanonicalNode} node
   */
  function pushNode(node) {
    nodes.push(node);
    currentNode = node;
    sortOrder += 1;
  }

  /**
   * @param {SourceBlockRow} block
   * @param {CanonicalNode} node
   */
  function appendBody(block, node) {
    const text = cleanText(block.exact_text);
    if (!text) return;

    node.body_text = node.body_text ? `${node.body_text}\n\n${text}` : text;
    node.source_block_ids.push(block.id);
    node.page_end = block.page_number;
    node.char_end = block.char_offset_end ?? node.char_end;

    chunks.push({
      node_key: node.node_key,
      chunk_index: chunks.filter(c => c.node_key === node.node_key).length,
      chunk_text: text,
      char_start: block.char_offset_start,
      char_end: block.char_offset_end,
      source_block_ids: [block.id],
    });
  }

  for (const block of blocks) {
    const heading = classifyHeading(block);

    if (heading) {
      const text = cleanText(block.exact_text);
      const line = firstLine(text);

      if (heading.nodeType === 'chapter') {
        const nodeKey = uniqueNodeKey('chapter', heading.ruleNumber, keySeen);
        const node = {
          node_key: nodeKey,
          node_type: 'chapter',
          rule_number: heading.ruleNumber,
          title: heading.title,
          body_text: '',
          sort_order: sortOrder,
          depth: 0,
          parent_key: null,
          page_start: block.page_number,
          page_end: block.page_number,
          char_start: block.char_offset_start,
          char_end: block.char_offset_end,
          source_block_ids: [block.id],
          metadata: { heading_line: line, role: block.style_metadata?.role ?? null },
        };
        pushNode(node);
        currentChapter = node;
        currentRule = null;
        continue;
      }

      if (heading.nodeType === 'rule') {
        const existing = ruleNodeByNumber.get(heading.ruleNumber);
        const existingBodyLen = (existing?.body_text ?? '').trim().length;

        if (existing && existingBodyLen > 100) {
          addWarning(warnings, {
            warning_code: 'DUPLICATE_RULE',
            message: `Duplicate rule heading ${heading.ruleNumber} on page ${block.page_number}; keeping first body.`,
            node_key: existing.node_key,
            source_block_id: block.id,
            source_page_id: block.source_page_id,
            details: { rule_number: heading.ruleNumber, page_number: block.page_number },
          });
          currentRule = existing;
          currentNode = existing;
          continue;
        }

        if (existing && existingBodyLen <= 100) {
          // Replace sparse/TOC placeholder with the substantive rule occurrence.
          existing.title = heading.title;
          existing.page_start = block.page_number;
          existing.page_end = block.page_number;
          existing.char_start = block.char_offset_start;
          existing.char_end = block.char_offset_end;
          existing.source_block_ids = [block.id];
          existing.metadata = { ...existing.metadata, heading_line: line, replaced_toc: true };
          currentRule = existing;
          currentNode = existing;
          ruleBodies.set(heading.ruleNumber, existing.body_text ?? '');
          continue;
        }

        const nodeKey = uniqueNodeKey('rule', heading.ruleNumber, keySeen);
        const node = {
          node_key: nodeKey,
          node_type: 'rule',
          rule_number: heading.ruleNumber,
          title: heading.title,
          body_text: '',
          sort_order: sortOrder,
          depth: currentChapter ? 1 : 0,
          parent_key: currentChapter?.node_key ?? null,
          page_start: block.page_number,
          page_end: block.page_number,
          char_start: block.char_offset_start,
          char_end: block.char_offset_end,
          source_block_ids: [block.id],
          metadata: { heading_line: line, role: block.style_metadata?.role ?? null },
        };
        pushNode(node);
        currentRule = node;
        ruleNodeByNumber.set(heading.ruleNumber, node);
        ruleBodies.set(heading.ruleNumber, '');
        continue;
      }

      if (heading.nodeType === 'subrule' && currentRule) {
        const subKey = `${currentRule.rule_number}(${heading.subKey})`;
        const nodeKey = uniqueNodeKey('subrule', subKey, keySeen);
        const node = {
          node_key: nodeKey,
          node_type: 'subrule',
          rule_number: currentRule.rule_number,
          title: heading.title,
          body_text: '',
          sort_order: sortOrder,
          depth: (currentRule.depth ?? 0) + 1,
          parent_key: currentRule.node_key,
          page_start: block.page_number,
          page_end: block.page_number,
          char_start: block.char_offset_start,
          char_end: block.char_offset_end,
          source_block_ids: [block.id],
          metadata: { sub_key: heading.subKey, heading_line: line },
        };
        pushNode(node);
        continue;
      }

      if (heading.nodeType === 'comment' || heading.nodeType === 'penalty') {
        const parentKey = currentRule?.node_key ?? currentChapter?.node_key ?? null;
        const nodeKey = uniqueNodeKey(heading.nodeType, `${block.page_number}-${block.block_index}`, keySeen);
        const node = {
          node_key: nodeKey,
          node_type: heading.nodeType,
          rule_number: currentRule?.rule_number ?? null,
          title: heading.title,
          body_text: text,
          sort_order: sortOrder,
          depth: parentKey ? (currentRule?.depth ?? 0) + 1 : 0,
          parent_key: parentKey,
          page_start: block.page_number,
          page_end: block.page_number,
          char_start: block.char_offset_start,
          char_end: block.char_offset_end,
          source_block_ids: [block.id],
          metadata: { heading_line: line },
        };
        pushNode(node);
        chunks.push({
          node_key: node.node_key,
          chunk_index: 0,
          chunk_text: text,
          char_start: block.char_offset_start,
          char_end: block.char_offset_end,
          source_block_ids: [block.id],
        });
        continue;
      }
    }

    if (!isBodyBlock(block) && !heading) continue;

    const target = [...nodes].reverse().find(n =>
      n.node_type === 'subrule' || n.node_type === 'rule',
    ) ?? currentNode;

    if (!target || (target.node_type !== 'rule' && target.node_type !== 'subrule')) {
      addWarning(warnings, {
        warning_code: 'ORPHAN_BODY',
        message: `Orphan body block on page ${block.page_number} idx ${block.block_index}; no active rule.`,
        source_block_id: block.id,
        source_page_id: block.source_page_id,
        details: { page_number: block.page_number, block_index: block.block_index },
      });
      continue;
    }

    appendBody(block, target);
    if (target.rule_number) {
      const prev = ruleBodies.get(target.rule_number) ?? '';
      ruleBodies.set(target.rule_number, prev + '\n' + cleanText(block.exact_text));
    }
  }

  for (const node of nodes) {
    if (node.node_type !== 'rule' && node.node_type !== 'subrule') continue;
    const body = (node.body_text ?? '').trim();
    if (!body || body.length >= SHORT_BODY_THRESHOLD) continue;

    const label = node.rule_number ? `Rule ${node.rule_number}` : node.node_key;
    addWarning(warnings, {
      warning_code: 'SHORT_BODY',
      message: `Suspiciously short node: ${label} has only ${body.length} character(s) of body text.`,
      node_key: node.node_key,
      details: {
        rule_number: node.rule_number,
        node_type: node.node_type,
        body_length: body.length,
        body_preview: body.slice(0, 80),
      },
    });
  }

  return { nodes, chunks, warnings };
}

/**
 * Sort blocks for reading order: page_number ASC, bbox.y ASC, block_index ASC.
 *
 * @param {SourceBlockRow[]} blocks
 * @returns {SourceBlockRow[]}
 */
export function sortBlocksReadingOrder(blocks) {
  return [...blocks].sort((a, b) => {
    if (a.page_number !== b.page_number) return a.page_number - b.page_number;
    const ay = a.read_y ?? 0;
    const by = b.read_y ?? 0;
    if (ay !== by) return ay - by;
    return a.block_index - b.block_index;
  });
}

export class Canonicalizer {
  /**
   * @param {import('pg').Pool|import('pg').PoolClient} db
   * @param {string} extractionRunId
   */
  constructor(db, extractionRunId) {
    this.db = db;
    this.extractionRunId = extractionRunId;
  }

  /**
   * Load source_blocks for an extraction run in reading order.
   *
   * @returns {Promise<SourceBlockRow[]>}
   */
  async loadBlocks() {
    const { rows } = await this.db.query(`
      SELECT
        sb.id,
        sb.extraction_run_id,
        sb.source_page_id,
        sb.block_index,
        sb.block_type,
        sb.char_offset_start,
        sb.char_offset_end,
        sb.bbox,
        sb.exact_text,
        sb.style_metadata,
        sp.page_number,
        (sb.bbox->>'y')::float AS read_y
      FROM source_blocks sb
      JOIN source_pages sp ON sp.id = sb.source_page_id
      WHERE sb.extraction_run_id = $1
      ORDER BY sp.page_number ASC, read_y ASC NULLS LAST, sb.block_index ASC
    `, [this.extractionRunId]);

    return rows;
  }

  /**
   * @returns {Promise<{ nodes: CanonicalNode[], chunks: CanonicalChunk[], warnings: CanonicalWarning[] }>}
   */
  async run() {
    const blocks = await this.loadBlocks();
    const sorted = sortBlocksReadingOrder(blocks);
    return canonicalizeBlocks(sorted);
  }
}

export default Canonicalizer;
