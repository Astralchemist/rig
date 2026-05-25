// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { fileIdOf, makeFileNode } from '../node-builders.ts';
import type { Edge, ExtractionResult, Node } from '../upstream-types.ts';

const depIdOf = (manifestPath: string, name: string): string => {
  const hash = createHash('sha256')
    .update(`${manifestPath}::dep::${name}`)
    .digest('hex')
    .slice(0, 32);
  return `dep:${hash}`;
};

// PEP 508 lite: name + spec on the same line.
// Examples:
//   pandas==2.1.4
//   numpy>=1.20,<2.0
//   requests~=2.31
//   markupsafe        (no version pin)
// Skipped:
//   blank lines, '# ...' comments, '-r <other>.txt', '-e .', '--<flag>'
const parseLine = (raw: string): { name: string; spec: string } | null => {
  const line = raw.split('#')[0]!.trim();
  if (!line) return null;
  if (line.startsWith('-') || line.startsWith('--')) return null;
  // strip trailing inline-extras like 'requests[security]' on the name half
  const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([!~<>=].*)?$/);
  if (!m) return null;
  const name = m[1]!;
  const spec = (m[3] ?? '').trim();
  return { name, spec };
};

const makeDepNode = (manifestPath: string, name: string, spec: string, isDev: boolean): Node => ({
  id: depIdOf(manifestPath, name),
  kind: 'declared-dependency',
  name,
  qualifiedName: spec ? `pypi:${name}${spec}` : `pypi:${name}`,
  filePath: manifestPath,
  language: 'json',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 0,
  depName: name,
  depSpec: spec || '*',
  depSource: 'pypi',
  isDevDep: isDev,
  isOptionalDep: false,
  isPeerDep: false,
  updatedAt: Date.now(),
});

// Convention: any file matching *requirements*-dev*.txt or *dev-requirements*.txt
// is treated as a dev-deps file. Plain requirements.txt → runtime deps.
const isDevManifest = (filePath: string): boolean => {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  return /(dev|test)[-_]?requirements|requirements[-_]?(dev|test)/.test(base);
};

export const extractRequirementsTxt = (
  filePath: string,
  source: string,
): Omit<ExtractionResult, 'durationMs'> => {
  const fileId = fileIdOf(filePath);
  const nodes: Node[] = [makeFileNode(fileId, filePath, 'json')];
  const edges: Edge[] = [];
  const dev = isDevManifest(filePath);
  for (const line of source.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const dep = makeDepNode(filePath, parsed.name, parsed.spec, dev);
    nodes.push(dep);
    edges.push({ source: fileId, target: dep.id, kind: 'manifest_declares', provenance: 'heuristic' });
  }
  return { nodes, edges, unresolvedReferences: [], errors: [] };
};
