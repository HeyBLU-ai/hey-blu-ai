/**
 * lib/ingest/docx-markdown.mjs
 *
 * DOCX → Markdown → structured sections. No PDF coordinates or TOC heuristics.
 */

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { chunkBodyText } from './node-chunks.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function docxBufferToMarkdown(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  turndown.keep(['table']);
  const raw = turndown.turndown(html).replace(/\r/g, '').trim();
  return normalizeBoldHeadings(raw);
}

/**
 * Word docs often use bold paragraphs instead of heading styles.
 * Promote standalone **Title** lines to ATX headings for section splitting.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeBoldHeadings(markdown) {
  const lines = markdown.split('\n');
  let usedH1 = false;

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    const boldOnly = trimmed.match(/^\*\*(.+)\*\*$/);
    if (!boldOnly) return line;

    const title = boldOnly[1].trim();
    if (title.length > 140) return line;

    if (!usedH1) {
      usedH1 = true;
      return `# ${title}`;
    }

    if (
      /^PR-\d+/i.test(title)
      || /^Minor\b/i.test(title)
      || /^STANDARD\b/i.test(title)
      || /^SCHEDULED\b/i.test(title)
      || /^PLAYER\b/i.test(title)
      || /^PITCHERS\b/i.test(title)
      || /^MANAGERS/i.test(title)
      || /^AGE$/i.test(title)
      || /^DAILY MAX$/i.test(title)
      || /^After\b/i.test(title)
      || /^Home Team/i.test(title)
      || /^Visiting Team/i.test(title)
      || /^Pinheiro Field/i.test(title)
    ) {
      return `## ${title}`;
    }

    return `## ${title}`;
  }).join('\n');
}

/**
 * @param {string} title
 * @returns {string|null}
 */
export function extractRuleNumber(title) {
  const pr = title.match(/\bPR-(\d+)\b/i);
  if (pr) return `PR-${pr[1]}`;

  const numbered = title.match(/^(\d{1,3})[.:]\s+/);
  if (numbered) return numbered[1];

  return null;
}

/**
 * @typedef {Object} DocxSection
 * @property {number} level - 1 = #, 2 = ##
 * @property {string} title
 * @property {string} body_text
 * @property {string|null} rule_number
 * @property {number} char_start
 * @property {number} char_end
 */

/**
 * @param {string} markdown
 * @returns {DocxSection[]}
 */
export function splitMarkdownSections(markdown) {
  const sections = [];
  /** @type {DocxSection|null} */
  let current = null;
  let charPos = 0;
  const bodyLines = [];

  function flush() {
    if (!current) return;
    const body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    sections.push({
      ...current,
      body_text: body,
      char_end: charPos,
    });
    bodyLines.length = 0;
  }

  for (const line of markdown.split('\n')) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);

    if (h1 || h2) {
      flush();
      const title = (h1 || h2)[1].trim();
      current = {
        level: h1 ? 1 : 2,
        title,
        rule_number: extractRuleNumber(title),
        char_start: charPos,
        char_end: charPos,
        body_text: '',
      };
    } else if (current) {
      bodyLines.push(line);
    }

    charPos += line.length + 1;
  }

  flush();
  return sections.filter((s) => s.title);
}

/**
 * @typedef {Object} DocxCanonicalNode
 * @property {string} node_key
 * @property {string} node_type
 * @property {string|null} rule_number
 * @property {string} title
 * @property {string} body_text
 * @property {number} sort_order
 * @property {number} depth
 * @property {string|null} parent_key
 * @property {number|null} char_start
 * @property {number|null} char_end
 */

/**
 * @typedef {Object} DocxCanonicalChunk
 * @property {string} node_key
 * @property {number} chunk_index
 * @property {string} chunk_text
 * @property {number|null} char_start
 * @property {number|null} char_end
 */

/**
 * @param {DocxSection[]} sections
 * @returns {{ nodes: DocxCanonicalNode[], chunks: DocxCanonicalChunk[] }}
 */
export function buildNodesFromSections(sections) {
  /** @type {DocxCanonicalNode[]} */
  const nodes = [];
  /** @type {DocxCanonicalChunk[]} */
  const chunks = [];
  /** @type {string|null} */
  let currentChapterKey = null;
  let sortOrder = 0;
  const keySeen = new Map();

  function uniqueKey(prefix, base) {
    const raw = `${prefix}:${base}`;
    const count = keySeen.get(raw) ?? 0;
    keySeen.set(raw, count + 1);
    return count === 0 ? raw : `${raw}-${count + 1}`;
  }

  for (const section of sections) {
    const isChapter = section.level === 1;
    const nodeKey = uniqueKey(
      isChapter ? 'chapter' : 'rule',
      section.rule_number ?? section.title.slice(0, 48),
    );

    const node = {
      node_key: nodeKey,
      node_type: isChapter ? 'chapter' : 'rule',
      rule_number: section.rule_number,
      title: section.title,
      body_text: section.body_text,
      sort_order: sortOrder,
      depth: isChapter ? 0 : (currentChapterKey ? 1 : 0),
      parent_key: isChapter ? null : currentChapterKey,
      char_start: section.char_start,
      char_end: section.char_end,
    };

    nodes.push(node);
    sortOrder += 1;

    if (isChapter) {
      currentChapterKey = nodeKey;
    }

    const textParts = section.body_text.trim()
      ? chunkBodyText(section.body_text)
      : [];

    if (!textParts.length && section.title.trim()) {
      textParts.push(section.title);
    }

    for (let i = 0; i < textParts.length; i += 1) {
      chunks.push({
        node_key: nodeKey,
        chunk_index: i,
        chunk_text: textParts[i],
        char_start: section.char_start,
        char_end: section.char_end,
      });
    }
  }

  return { nodes, chunks };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ markdown: string, sections: DocxSection[], nodes: DocxCanonicalNode[], chunks: DocxCanonicalChunk[] }>}
 */
export async function parseDocxToGraph(buffer) {
  const markdown = await docxBufferToMarkdown(buffer);
  const sections = splitMarkdownSections(markdown);
  const { nodes, chunks } = buildNodesFromSections(sections);
  return { markdown, sections, nodes, chunks };
}

export { DOCX_MIME };

export default {
  docxBufferToMarkdown,
  normalizeBoldHeadings,
  splitMarkdownSections,
  buildNodesFromSections,
  parseDocxToGraph,
  extractRuleNumber,
};
