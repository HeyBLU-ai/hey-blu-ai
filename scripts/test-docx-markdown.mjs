#!/usr/bin/env node
/**
 * Unit checks for DOCX markdown section parsing (no PDF heuristics).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeBoldHeadings,
  splitMarkdownSections,
  parseDocxToGraph,
} from '../lib/ingest/docx-markdown.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log('DOCX markdown parser tests\n');

const sample = [
  '**NSLL 2024 Minors AAA Local Rules of Play**',
  '',
  'Intro paragraph about the division.',
  '',
  '**PR-1 Game Responsibilities**',
  '',
  'Home team duties listed here.',
  '',
  '**PR-3 Game Time Limit**',
  '',
  'No inning starts after 2 hours.',
].join('\n');

const normalized = normalizeBoldHeadings(sample);
check('promotes first bold line to H1', normalized.startsWith('# NSLL'));
check('promotes PR-1 to H2', normalized.includes('## PR-1 Game Responsibilities'));
check('promotes PR-3 to H2', normalized.includes('## PR-3 Game Time Limit'));

const sections = splitMarkdownSections(normalized);
check('finds 3 sections', sections.length === 3);
check('PR-1 rule number', sections[1].rule_number === 'PR-1');
check('PR-1 has body', sections[1].body_text.includes('Home team'));

const docxPath = resolve(__dirname, '../rulebooks/2025-NSLL-Minor-AAA-Local-Rules-1.docx');
const buf = readFileSync(docxPath);
const graph = await parseDocxToGraph(buf);
check('NSLL fixture has sections', graph.sections.length >= 10);
check('NSLL fixture has nodes', graph.nodes.length >= 10);
check('NSLL fixture has chunks', graph.chunks.length >= 10);
check('includes PR-8 pitching', graph.sections.some((s) => s.rule_number === 'PR-8'));
check('no PDF TOC heuristic fields', graph.nodes.every((n) => n.page_start === undefined));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
