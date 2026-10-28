// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { ExtractionResult, Node } from './upstream-types.ts';

const idOf = (filePath: string, line: number, name: string): string => {
  const hash = createHash('sha256')
    .update(`${filePath}:markdown:${name}:${line}`)
    .digest('hex')
    .slice(0, 32);
  return `markdown:${hash}`;
};

// Longest excerpt kept per section, in characters.
export const EXCERPT_MAX = 400;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

// The prose under a heading, up to the next heading: code blocks, HTML lines
// and table rules left out, list/quote markers and inline markup stripped,
// whitespace collapsed, cut at a word boundary within EXCERPT_MAX.
export const sectionExcerpt = (lines: readonly string[], from: number): string => {
  const out: string[] = [];
  let len = 0;
  let inFence = false;
  for (let i = from; i < lines.length && len < EXCERPT_MAX; i++) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (HEADING.test(line)) break;
    const text = line
      .replace(/^\s*(?:[-*+]|\d+[.)]|>+)\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_|]+/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || /^[-: ]+$/.test(text)) continue;
    out.push(text);
    len += text.length + 1;
  }
  const joined = out.join(' ');
  if (joined.length <= EXCERPT_MAX) return joined;
  const cut = joined.slice(0, EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');
  return space > EXCERPT_MAX / 2 ? cut.slice(0, space) : cut;
};

/**
 * Rig-native markdown extractor. ATX headings only — each heading becomes
 * a 'markdown-section' node whose qualifiedName encodes the heading path
 * (e.g. 'Top.Section.Subsection') and whose excerpt holds the start of its
 * prose. Setext-style and code-block headings are skipped.
 */
export function extractMarkdown(
  filePath: string,
  source: string,
): Omit<ExtractionResult, 'durationMs'> {
  const lines = source.split('\n');
  const nodes: Node[] = [];
  const stack: { level: number; name: string }[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(HEADING);
    if (!m) continue;
    const level = m[1]!.length;
    const name = m[2]!.trim();
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const qn = [...stack.map((s) => s.name), name].join('.');
    const excerpt = sectionExcerpt(lines, i + 1);
    nodes.push({
      id: idOf(filePath, i + 1, qn),
      kind: 'markdown-section',
      name,
      qualifiedName: qn,
      filePath,
      language: 'markdown',
      startLine: i + 1,
      endLine: i + 1,
      startColumn: 0,
      endColumn: line.length,
      ...(excerpt ? { excerpt } : {}),
      updatedAt: Date.now(),
    });
    stack.push({ level, name });
  }
  return { nodes, edges: [], unresolvedReferences: [], errors: [] };
}
