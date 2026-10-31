// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
// Source: src/types.ts (cherry-picked: only the extraction-relevant slice).
// LARGE / derived — do not Rig-ify.

export const NODE_KINDS = [
  'file',
  'module',
  'markdown-section',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'declared-dependency',
  'conversation-waypoint',
  'skill',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_of'
  | 'returns'
  | 'instantiates'
  | 'overrides'
  | 'decorates'
  | 'tests'
  | 'manifest_declares'
  | 'waypoint_succeeds'
  | 'waypoint_references';

export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'markdown',
  'json',
  'unknown',
] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  // declared-dependency fields (A2). Populated only when kind = 'declared-dependency'.
  depName?: string;
  depSpec?: string;
  depSource?: string;
  isDevDep?: boolean;
  isOptionalDep?: boolean;
  isPeerDep?: boolean;
  // A2 lockfile resolution — concrete installed version, populated post-extract
  // by enrichDependenciesFromLockfiles when a sibling lockfile is present.
  resolvedVersion?: string;
  // markdown-section: the start of the section's own prose (up to the next
  // heading, code blocks left out), for search and embedding.
  excerpt?: string;
  updatedAt: number;
}

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown>;
  line?: number;
  column?: number;
  provenance?: 'tree-sitter' | 'heuristic';
}

export interface UnresolvedReference {
  fromNodeId: string;
  referenceName: string;
  referenceKind: EdgeKind;
  line: number;
  column: number;
  filePath?: string;
  language?: Language;
  candidates?: string[];
  // Imports only: the local name `import pandas as pd` binds ('pd'), kept for
  // automatic aliasing (backlog A3).
  alias?: string;
  // Imports only: the names `from pkg import a, b` pulls in, which may be
  // submodules of pkg.
  importedNames?: string[];
  // Callbacks: the function this one is handed to (`retry(save)`), which may
  // call it. The resolver links viaCallee -> referenceName, not the owner.
  viaCallee?: string;
}

export interface ExtractionError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  code?: string;
}

export interface ExtractionResult {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
  durationMs: number;
}
