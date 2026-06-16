/**
 * lib/ingest/ll-master-builder.mjs
 *
 * Build a merged Little League playing-rules master from:
 *   - 2024 base (PDF or DOCX)
 *   - 2025 / 2026 significant-changes documents
 */

import { readFileSync, existsSync } from 'fs';
import mammoth from 'mammoth';
import { PDFParse, VerbosityLevel } from 'pdf-parse';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from 'docx';

const INSTRUCTOR_LINE_RE = /INSTRUCTORS?[\u2019''`´]?s?\s*COMMENTS?:?/i;
const PAGE_HEADER_RE = /Little League®?\s*Umpire Academy\s*Rules Instruction Manual\s*Page\s+\d+/gi;
const INSTRUCTOR_STOP_RE = /\n(?:\([a-z]\)(?:\s+\(\d\))?|\([a-z]\)\s+\(\d\)|(?:[1-8]\.\d{2}[a-z]?)\s*[-–]|RULE\s+[1-8]\.00|NOTE\s*:|NOTE\s+\d|A\.R\.)/i;
const INSTRUCTOR_BLOCK_RE = new RegExp(
  `INSTRUCTORS?[\\u2019''\`´]?s?\\s*COMMENTS?:?[\\s\\S]*?(?=${INSTRUCTOR_STOP_RE.source})`,
  'gi',
);

const MAJOR_TITLES = {
  '1.00': 'OBJECTIVES OF THE GAME',
  '2.00': 'DEFINITION OF TERMS',
  '3.00': 'GAME PRELIMINARIES',
  '4.00': 'STARTING AND ENDING THE GAME',
  '5.00': 'PUTTING THE BALL IN PLAY — LIVE BALL',
  '6.00': 'THE BATTER',
  '7.00': 'THE RUNNER',
  '8.00': 'THE PITCHER',
};

/**
 * @param {string} text
 */
export function stripInstructorLines(text) {
  const lines = (text ?? '').split('\n');
  const out = [];
  let skipping = false;

  for (const line of lines) {
    if (INSTRUCTOR_LINE_RE.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (
        /^([1-8]\.\d{2}[a-z]?)\s*[-–]/i.test(line)
        || /^RULE\s+[1-8]\.00/i.test(line)
        || /^NOTE\s*:/i.test(line)
        || /^NOTE\s+\d/i.test(line)
        || /^A\.R\./i.test(line)
        || /^\([a-z]\)/i.test(line.trim())
      ) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    if (/^Diagrams No\./i.test(line.trim())) continue;
    out.push(line);
  }

  return out.join('\n');
}

/**
 * @param {string} text
 */
export function cleanExtractedText(text) {
  return stripInstructorLines(
    (text ?? '')
      .replace(/\r/g, '')
      .replace(PAGE_HEADER_RE, '\n')
      .replace(INSTRUCTOR_BLOCK_RE, '\n')
      .replace(/[Ø•]\s*/g, '')
      .replace(/^Worn centered on the left shoulder\s*\n\s*sleeve;[^\n]*\n\s*chest on sleeveless style\.\s*\n?/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' '),
  ).trim();
}

/**
 * @param {string} html
 */
export function htmlToPlainText(html) {
  return cleanExtractedText(
    html
      .replace(/<img[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'),
  );
}

/**
 * @param {Buffer} buffer
 */
export async function extractTextFromDocx(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return htmlToPlainText(html);
}

/**
 * @param {Buffer} buffer
 */
export async function extractPlayingRulesFromPdf(buffer) {
  const parser = new PDFParse({
    data: new Uint8Array(buffer),
    verbosity: VerbosityLevel.ERRORS,
  });
  let result;
  try {
    result = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const full = cleanExtractedText(result.pages.map((p) => p.text).join('\n'));
  const start = full.search(/RULE\s+1\.00\s*[-–]/i);
  if (start < 0) throw new Error('Could not locate RULE 1.00 in base PDF.');

  let end = full.length;
  const endMatch = full.search(/RULE\s+9\.00\s*[-–]/i);
  if (endMatch > start) end = endMatch;

  const slice = full.slice(start, end).trim();
  return { text: slice, source: 'pdf' };
}

/**
 * @typedef {Object} RuleBlock
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {string} major - e.g. "1.00"
 */

/**
 * @param {string} text
 * @returns {{ majors: { id: string, title: string, start: number }[], blocks: RuleBlock[] }}
 */
export function parseRuleBlocks(text) {
  const cleaned = cleanExtractedText(text);
  const majors = [];
  for (const m of cleaned.matchAll(/\n\s*RULE\s+([1-8])\.00\s*[-–]\s*([^\n]+)/gi)) {
    majors.push({ id: `${m[1]}.00`, title: m[2].trim(), start: m.index ?? 0 });
  }

  const blocks = [];
  const lines = cleaned.split('\n');
  /** @type {RuleBlock|null} */
  let current = null;
  let currentMajor = '1.00';

  for (const line of lines) {
    const major = line.match(/^\s*RULE\s+([1-8])\.00\s*[-–]\s*(.+)$/i);
    if (major) {
      currentMajor = `${major[1]}.00`;
      if (current) blocks.push(current);
      current = null;
      continue;
    }

    const rule = line.match(/^([1-8]\.\d{2}[a-z]?)\s*[-–]\s*(.*)$/i)
      ?? line.match(/^([1-8]\.\d{2}[a-z]?)\s*-\s*$/i);
    if (rule) {
      if (current) blocks.push(current);
      current = {
        id: rule[1],
        title: (rule[2] ?? '').trim(),
        body: '',
        major: currentMajor,
      };
      continue;
    }

    if (current) {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  if (current) blocks.push(current);

  // Inject synthetic RULE 3.00 if 3.xx blocks exist without header
  const has3 = majors.some((m) => m.id === '3.00');
  const has3xx = blocks.some((b) => b.id.startsWith('3.'));
  if (!has3 && has3xx) {
    majors.push({ id: '3.00', title: 'GAME PRELIMINARIES', start: -1 });
    majors.sort((a, b) => Number(a.id) - Number(b.id));
    for (const b of blocks) {
      if (b.id.startsWith('3.')) b.major = '3.00';
    }
  }

  for (const b of blocks) {
    b.body = cleanExtractedText(b.body);
    b.major = `${b.id.split('.')[0]}.00`;
  }

  const majorIds = new Set(majors.map((m) => m.id));
  for (const b of blocks) {
    if (!majorIds.has(b.major)) {
      majors.push({ id: b.major, title: MAJOR_TITLES[b.major] ?? b.major, start: -1 });
      majorIds.add(b.major);
    }
  }
  majors.sort((a, b) => Number(a.id) - Number(b.id));

  return { majors, blocks };
}

/**
 * @typedef {Object} UpdateEntry
 * @property {number} year
 * @property {string[]} ruleRefs - e.g. ["1.10", "3.04", "7.14(b)"]
 * @property {string} label
 * @property {string} text
 */

/**
 * @param {string} text
 * @param {number} year
 * @returns {UpdateEntry[]}
 */
export function parseSignificantChanges(text, year) {
  const cleaned = htmlToPlainText(text)
    .replace(/Significant Updates?/gi, '')
    .replace(/\n\d+\s*\n/g, '\n');

  const entries = [];
  // Next-entry boundary: sport-prefixed lines only — avoids stopping on "Removes Rule 1.11(j)" in body text
  const nextEntryRe = '(?=\\n(?:Baseball|Softball|Challenger|Baseball and Softball)[^–\\n]*–\\s*Rule\\s+\\d|$)';
  const chunkRe = new RegExp(
    `(?:(?:Baseball|Softball|Challenger|Baseball and Softball)[^–\\n]*–\\s*)?Rule\\s+([\\d.,()a-z\\s]+?)\\s*[-–]\\s*([^:\\n]+):\\s*([\\s\\S]*?)${nextEntryRe}`,
    'gi',
  );

  let match;
  while ((match = chunkRe.exec(cleaned)) !== null) {
    const refsRaw = match[1]
      .replace(/\band\b/gi, ',')
      .split(/[,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    const ruleRefs = [];
    for (const part of refsRaw) {
      const normalized = part
        .replace(/^Rule\s+/i, '')
        .replace(/\s+/g, '')
        .replace(/T-(\d)/i, '$1'); // tournament rule refs ignored for playing book
      if (/^\d/.test(normalized)) ruleRefs.push(normalized);
    }

    if (!ruleRefs.length) continue;

    entries.push({
      year,
      ruleRefs,
      label: match[2].trim(),
      text: cleanExtractedText(match[3]),
    });
  }

  return entries;
}

/**
 * @param {string} ref
 */
export function baseRuleId(ref) {
  const m = ref.match(/^([1-8]\.\d{2})/);
  return m ? m[1] : ref.replace(/\(.*$/, '');
}

/**
 * @param {string} body
 * @param {UpdateEntry} update
 */
export function applyUpdateToRuleBody(body, update) {
  let next = body;
  const label = update.label.toLowerCase();
  const text = update.text.trim();
  const refs = update.ruleRefs.join(' ').toLowerCase();

  // Compound subsection e.g. 1.11(a)(3)
  if (/\(a\)\(3\)/i.test(label + refs) || /pitcher.?s undershirt|neoprene sleeve|sleeves worn by the pitcher/i.test(label + text)) {
    const replacement = `(3) Any part of the pitcher's undershirt or T-shirt exposed to view shall be of a solid color. For baseball the sleeves may not be white or gray. Sleeves (including neoprene) are permitted to be worn by a pitcher without being covered by an undershirt, provided the sleeve is a solid color and not white or gray.
The use of play calling bands by defensive players is permitted under the following conditions:
o The equipment must be worn as the manufacturer intended (i.e. on either the wrist or forearm)
o The play calling band may not be attached to the belt or any other location on the player's person.
o Baseball and Softball pitchers are permitted to wear a play calling band on their non-pitching (glove) arm,
provided it is a solid color and not white, gray, or optic yellow. If the umpire considers it distracting to the
batter, he/she may have it removed.`;
    const subRe = /\(3\)[\s\S]*?(?=\n\(b\)\s|\nNOTE:|$)/i;
    if (subRe.test(next)) {
      return cleanExtractedText(next.replace(subRe, replacement));
    }
  }

  // NOTE N replacements — prefer pine-tar specific NOTE 2
  const noteNum = label.match(/note\s*(\d+)/i)?.[1];
  if (noteNum === '2' && /pine\s*tar/i.test(label + text)) {
    if (/NOTE\s+2:\s*The use of pine tar/i.test(next)) {
      next = next.replace(
        /NOTE\s+2:\s*The use of pine tar[\s\S]*?(?=NOTE\s+3|NOTE\s+4|A\.R\.|$)/i,
        'NOTE 2: The use of pine tar or any other similar adhesive substance is permitted at all levels of Little League Baseball and Softball.\n',
      );
      return cleanExtractedText(next);
    }
  }

  if (noteNum) {
    const noteRe = new RegExp(
      `NOTE\\s+${noteNum}\\s*[:\\-–][^\\n]*(?:\\n(?!NOTE\\s+\\d|A\\.R\\.)[^\\n]*)*`,
      'i',
    );
    if (noteRe.test(next)) {
      return next.replace(noteRe, `NOTE ${noteNum}: ${text}`);
    }
  }

  // A.R. replacements
  const arMatch = label.match(/a\.r\.\s*(\d+)/i);
  if (arMatch) {
    const arNum = arMatch[1];
    const arRe = new RegExp(
      `A\\.R\\.?\\s*(?:${arNum}|[-–])[^\\n]*(?:\\n(?!A\\.R\\.|NOTE\\s+\\d|INSTRUCTOR)[^\\n]*)*`,
      'i',
    );
    if (arRe.test(next)) {
      return cleanExtractedText(next.replace(arRe, `A.R. ${arNum} – ${text}`));
    }
  }

  if (/thumb protectors|choke-knob|choke-up assist|alterations or modification/i.test(label + text)) {
    let arBody = text
      .replace(/^Clarifies that\s+/i, '')
      .replace(/^Updates wording to permit the use of thumb protectors and clarifies that\s+/i, '')
      .replace(/^Updates wording to\s+/i, '');
    arBody = arBody.charAt(0).toUpperCase() + arBody.slice(1);
    if (/A\.R\.?\s*(?:2|[-–])/i.test(next)) {
      next = next.replace(
        /A\.R\.?\s*(?:2|[-–])[^\n]*(?:\n(?!A\.R\.|NOTE\s+\d|INSTRUCTOR)[^\n]*)*/i,
        `A.R. 2 – ${arBody}`,
      );
      if (next !== body) {
        return cleanExtractedText(next);
      }
    }
  }

  // Keyword-driven patches (before lettered subsection — update docs often summarize, not quote)
  if (/pine\s*tar/i.test(label + text)) {
    next = next.replace(
      /NOTE\s+2:\s*The use of pine tar[\s\S]*?(?=NOTE\s+3|NOTE\s+4|A\.R\.|$)/i,
      'NOTE 2: The use of pine tar or any other similar adhesive substance is permitted at all levels of Little League Baseball and Softball.',
    );
    if (next !== body) {
      return cleanExtractedText(next);
    }
  }

  if (/jewelry/i.test(label + text)) {
    const jewelryText = '(j) Jewelry is permitted to be worn. Jewelry that alerts medical personnel to a specific condition is permissible. Hard items to control the hair, such as beads, are permitted.';
    if (/\(j\)\s*Players must not wear jewelry/i.test(next)) {
      next = next.replace(
        /\(j\)\s*Players must not wear jewelry[\s\S]*?(?=\(k\)|$)/i,
        jewelryText,
      );
    } else if (/\(j\)\s*Removes$/i.test(next.trim()) || /\(j\)\s*Removes\s*$/i.test(next)) {
      next = next.replace(/\(j\)\s*Removes/i, jewelryText);
    }
    if (next !== body) {
      return cleanExtractedText(next);
    }
  }

  if (/helmet stickers|helmet sticker/i.test(label + text)) {
    next = next.replace(
      /Helmets may not be re-painted and may not contain tape or re-applied decals unless approved in writing by the helmet manufacturer or authorized dealer\./gi,
      'Helmet stickers or decals are permitted, provided that such usage is not excessive, is not offensive, and does not make inappropriate references, such as that to drugs or alcohol. Helmets may not be re-painted and may not contain tape or re-applied decals unless approved in writing by the helmet manufacturer or authorized dealer.',
    );
    if (next !== body) {
      return cleanExtractedText(next);
    }
  }

  if (/forfeited games|scorebook.*umpire/i.test(label + text)) {
    next = next.replace(
      /signed by the Umpire-in-Chief[^\n.]*/gi,
      'recorded in the scorebook (signature by the Umpire-in-Chief is not required)',
    );
    if (next !== body) {
      return cleanExtractedText(next);
    }
  }

  // Lettered subsection — skip if compound (a)(3) already handled
  const subMatch = !/\(a\)\(3\)/i.test(label + refs)
    ? (label.match(/\(([a-z])\)/i) || refs.match(/\(([a-z])\)/i))
    : null;
  if (subMatch) {
    const letter = subMatch[1];
    const subRe = new RegExp(
      `\\(${letter}\\)[^\\n]*(?:\\n(?!\\([a-z]\\))[^\\n]*)*`,
      'i',
    );
    if (subRe.test(next) && text.length > 25 && !/^removes?\b/i.test(text)) {
      return next.replace(subRe, `(${letter}) ${text}`);
    }
  }

  // Whole-rule numbered subsection e.g. 6.06(d)
  const numberedSub = update.ruleRefs.find((r) => /\([a-z]\)/i.test(r));
  if (numberedSub) {
    const letter = numberedSub.match(/\(([a-z])\)/i)?.[1];
    if (letter) {
      const subRe = new RegExp(
        `\\(${letter}\\)[^\\n]*(?:\\n(?!\\([a-z]\\))[^\\n]*)*`,
        'i',
      );
      if (subRe.test(next) && text.length > 25 && !/^removes?\b/i.test(text)) {
        return next.replace(subRe, `(${letter}) ${text}`);
      }
    }
  }

  // Fallback: append change notice when no in-place patch matched
  if (next === body) {
    next = `${body}\n\n[${update.year} SIGNIFICANT CHANGE — ${update.label}]: ${text}`;
  }

  return cleanExtractedText(next);
}

/**
 * @param {RuleBlock[]} blocks
 * @param {UpdateEntry[]} updates
 */
export function mergeUpdates(blocks, updates) {
  const byId = new Map();
  for (const block of blocks) {
    if (!byId.has(block.id)) byId.set(block.id, []);
    byId.get(block.id).push(block);
  }

  const sorted = [...updates].sort((a, b) => a.year - b.year);
  let applied = 0;

  for (const update of sorted) {
    for (const ref of update.ruleRefs) {
      const id = baseRuleId(ref);
      const targets = byId.get(id);
      if (!targets?.length) continue;
      for (const block of targets) {
        const merged = applyUpdateToRuleBody(block.body, { ...update, ruleRefs: [ref] });
        if (merged !== block.body) applied += 1;
        block.body = cleanExtractedText(merged);
      }
    }
  }

  return { blocks, appliedCount: applied, updateCount: sorted.length };
}

/**
 * @param {{ majors: { id: string, title: string }[], blocks: RuleBlock[] }} parsed
 * @returns {Paragraph[]}
 */
export function buildDocxParagraphs(parsed) {
  const { majors, blocks } = parsed;
  /** @type {Paragraph[]} */
  const children = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: '2026 Little League Master Playing Rules (Base 2024 + Updates 2025/2026)',
          bold: true,
          size: 32,
        }),
      ],
    }),
  );

  const majorOrder = [...majors].sort((a, b) => Number(a.id) - Number(b.id));
  const blocksByMajor = new Map();
  for (const block of blocks) {
    if (!blocksByMajor.has(block.major)) blocksByMajor.set(block.major, []);
    blocksByMajor.get(block.major).push(block);
  }

  for (const major of majorOrder) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        children: [
          new TextRun({
            text: `RULE ${major.id} – ${major.title}`,
            bold: true,
            size: 28,
          }),
        ],
      }),
    );

    const majorBlocks = blocksByMajor.get(major.id) ?? [];
    for (const block of majorBlocks) {
      // Short bold header for ingest indexing; full title preserved in body text.
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({ text: block.id, bold: true, size: 24 }),
          ],
        }),
      );

      const bodyParts = [];
      if (block.title) bodyParts.push(block.title);
      if (block.body) bodyParts.push(block.body);
      for (const para of bodyParts.join('\n\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: para, size: 22 })],
          }),
        );
      }
    }
  }

  return children;
}

/**
 * @param {Paragraph[]} children
 * @param {string} outputPath
 */
export async function writeDocx(children, outputPath) {
  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

/**
 * @param {Object} opts
 * @param {string} opts.basePdfPath
 * @param {string} [opts.baseDocxPath]
 * @param {string} opts.updates2025Path
 * @param {string} opts.updates2026Path
 */
export async function buildMasterLittleLeagueBook(opts) {
  let baseText;
  let baseSource;

  if (opts.baseDocxPath && existsSync(opts.baseDocxPath)) {
    const raw = await extractTextFromDocx(readFileSync(opts.baseDocxPath));
    const start = raw.search(/RULE\s+1\.00\s*[-–]/i);
    if (start < 0) throw new Error('Could not locate RULE 1.00 in base DOCX.');
    const end = raw.search(/RULE\s+9\.00\s*[-–]/i);
    baseText = cleanExtractedText(raw.slice(start, end > start ? end : undefined));
    baseSource = 'docx';
  } else if (existsSync(opts.basePdfPath)) {
    const extracted = await extractPlayingRulesFromPdf(readFileSync(opts.basePdfPath));
    baseText = extracted.text;
    baseSource = extracted.source;
  } else {
    throw new Error('No base rulebook found (expected DOCX or PDF).');
  }

  const parsed = parseRuleBlocks(baseText);

  const updates2025 = parseSignificantChanges(
    await extractTextFromDocx(readFileSync(opts.updates2025Path)),
    2025,
  );
  const updates2026 = parseSignificantChanges(
    await extractTextFromDocx(readFileSync(opts.updates2026Path)),
    2026,
  );

  const { blocks, appliedCount, updateCount } = mergeUpdates(parsed.blocks, [
    ...updates2025,
    ...updates2026,
  ]);

  for (const block of blocks) {
    block.body = cleanExtractedText(block.body);
  }

  const paragraphs = buildDocxParagraphs({ majors: parsed.majors, blocks });
  const buffer = await writeDocx(paragraphs, opts.outputPath);

  return {
    baseSource,
    baseChars: baseText.length,
    majorSections: parsed.majors.length,
    ruleBlocks: blocks.length,
    updatesParsed: updateCount,
    updatesApplied: appliedCount,
    outputBytes: buffer.length,
    buffer,
    ruleIds: blocks.map((b) => b.id),
  };
}

export default {
  buildMasterLittleLeagueBook,
  extractPlayingRulesFromPdf,
  parseRuleBlocks,
  parseSignificantChanges,
  mergeUpdates,
};
