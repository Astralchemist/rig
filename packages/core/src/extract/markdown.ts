// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ExtractionResult, Node, UnresolvedReference } from './upstream-types.ts';

// [text](target) with a relative target: not a URL, not a pure #anchor.
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
// `name`, `name()`, `obj.name()`: code-like only (camelCase, PascalCase,
// snake_case, or called), so prose words in backticks don't match.
const CODE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?`/g;
const codeLike = (name: string, called: boolean): boolean =>
  called || /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]/.test(name);

/** A link target as a project-relative path, or null for URLs, anchors and paths leaving the repo. */
export const linkTarget = (fromFile: string, target: string): string | null => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/'))
    return null;
  const path = decodeURIComponent(target.split('#')[0]!.split('?')[0]!);
  if (!path) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), path));
  return joined.startsWith('..') ? null : joined.replace(/^\.\//, '');
};

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
  const refs: UnresolvedReference[] = [];
  // Links and code names in a section's prose belong to that section.
  const scanProse = (line: string, i: number): void => {
    const owner = nodes[nodes.length - 1];
    if (!owner) return;
    const seen = new Set<string>();
    for (const m of line.matchAll(LINK)) {
      const target = linkTarget(filePath, m[1]!);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      refs.push({
        fromNodeId: owner.id,
        referenceName: target,
        referenceKind: 'references',
        line: i + 1,
        column: m.index ?? 0,
        filePath,
        language: 'markdown',
        targetPath: target,
      });
    }
    for (const m of line.replace(LINK, '').matchAll(CODE)) {
      const name = m[1]!.split('.').pop()!;
      if (!codeLike(name, !!m[2]) || seen.has(name)) continue;
      seen.add(name);
      refs.push({
        fromNodeId: owner.id,
        referenceName: name,
        referenceKind: 'references',
        line: i + 1,
        column: m.index ?? 0,
        filePath,
        language: 'markdown',
      });
    }
  };
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
    if (!m) {
      scanProse(line, i);
      continue;
    }
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
  return { nodes, edges: [], unresolvedReferences: refs, errors: [] };
}
