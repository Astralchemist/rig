import { createHash } from 'node:crypto';
import type { ExtractionResult, Node } from './upstream-types.ts';

const idOf = (filePath: string, line: number, name: string): string => {
  const hash = createHash('sha256').update(`${filePath}:markdown:${name}:${line}`).digest('hex').slice(0, 32);
  return `markdown:${hash}`;
};

/**
 * Rig-native markdown extractor. ATX headings only — each heading becomes
 * a 'markdown-section' node whose qualifiedName encodes the heading path
 * (e.g. 'Top.Section.Subsection'). Setext-style and code-block headings are skipped.
 */
export function extractMarkdown(filePath: string, source: string): Omit<ExtractionResult, 'durationMs'> {
  const lines = source.split('\n');
  const nodes: Node[] = [];
  const stack: { level: number; name: string }[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const level = m[1]!.length;
    const name = m[2]!.trim();
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    const qn = [...stack.map((s) => s.name), name].join('.');
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
      updatedAt: Date.now(),
    });
    stack.push({ level, name });
  }
  return { nodes, edges: [], unresolvedReferences: [], errors: [] };
}
