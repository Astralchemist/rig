import { createHash } from 'node:crypto';
import { fileIdOf, makeFileNode } from '../node-builders.ts';
import type { Edge, ExtractionResult, Node } from '../upstream-types.ts';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const depIdOf = (manifestPath: string, name: string): string => {
  const hash = createHash('sha256')
    .update(`${manifestPath}::dep::${name}`)
    .digest('hex')
    .slice(0, 32);
  return `dep:${hash}`;
};

const makeDepNode = (
  manifestPath: string,
  name: string,
  spec: string,
  flags: { isDev?: boolean; isOptional?: boolean; isPeer?: boolean },
): Node => ({
  id: depIdOf(manifestPath, name),
  kind: 'declared-dependency',
  name,
  qualifiedName: `npm:${name}@${spec}`,
  filePath: manifestPath,
  language: 'json',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 0,
  depName: name,
  depSpec: spec,
  depSource: 'npm',
  isDevDep: flags.isDev === true,
  isOptionalDep: flags.isOptional === true,
  isPeerDep: flags.isPeer === true,
  updatedAt: Date.now(),
});

export const extractPackageJson = (
  filePath: string,
  source: string,
): Omit<ExtractionResult, 'durationMs'> => {
  let parsed: PackageJson;
  try {
    parsed = JSON.parse(source) as PackageJson;
  } catch {
    return { nodes: [], edges: [], unresolvedReferences: [], errors: [] };
  }
  const fileId = fileIdOf(filePath);
  const nodes: Node[] = [makeFileNode(fileId, filePath, 'json')];
  const edges: Edge[] = [];

  const addAll = (
    map: Record<string, string> | undefined,
    flags: { isDev?: boolean; isOptional?: boolean; isPeer?: boolean },
  ): void => {
    if (!map) return;
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== 'string') continue;
      const dep = makeDepNode(filePath, name, spec, flags);
      nodes.push(dep);
      edges.push({ source: fileId, target: dep.id, kind: 'manifest_declares', provenance: 'heuristic' });
    }
  };

  addAll(parsed.dependencies, {});
  addAll(parsed.devDependencies, { isDev: true });
  addAll(parsed.peerDependencies, { isPeer: true });
  addAll(parsed.optionalDependencies, { isOptional: true });

  return { nodes, edges, unresolvedReferences: [], errors: [] };
};
