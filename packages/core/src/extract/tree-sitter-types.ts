// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
// Source: src/extraction/tree-sitter-types.ts (verbatim, import paths rewired).
// LARGE — do not Rig-ify.

import { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind, UnresolvedReference } from './upstream-types.ts';

export interface ImportInfo {
  moduleName: string;
  signature: string;
  handledRefs?: boolean;
  // Local name bound by `import x as y` ('y').
  alias?: string;
}

export interface VariableInfo {
  name: string;
  kind: NodeKind;
  signature?: string;
  delegateToFunction?: SyntaxNode;
  positionNode?: SyntaxNode;
}

export interface ExtractorContext {
  createNode(kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<Node>): Node | null;
  visitNode(node: SyntaxNode): void;
  visitFunctionBody(body: SyntaxNode, functionId: string): void;
  addUnresolvedReference(ref: UnresolvedReference): void;
  pushScope(nodeId: string): void;
  popScope(): void;
  readonly filePath: string;
  readonly source: string;
  readonly nodeStack: readonly string[];
  readonly nodes: readonly Node[];
}

export interface LanguageExtractor {
  // --- Node type mappings ---
  functionTypes: string[];
  classTypes: string[];
  methodTypes: string[];
  interfaceTypes: string[];
  structTypes: string[];
  enumTypes: string[];
  enumMemberTypes?: string[];
  typeAliasTypes: string[];
  importTypes: string[];
  callTypes: string[];
  variableTypes: string[];
  fieldTypes?: string[];
  propertyTypes?: string[];

  // --- Field name mappings ---
  nameField: string;
  bodyField: string;
  paramsField: string;
  returnField?: string;

  // --- Existing hooks ---
  getSignature?: (node: SyntaxNode, source: string) => string | undefined;
  getVisibility?: (
    node: SyntaxNode,
  ) => 'public' | 'private' | 'protected' | 'internal' | undefined;
  isExported?: (node: SyntaxNode, source: string) => boolean;
  isAsync?: (node: SyntaxNode) => boolean;
  isStatic?: (node: SyntaxNode) => boolean;
  isConst?: (node: SyntaxNode) => boolean;

  // --- New config properties ---
  extraClassNodeTypes?: string[];
  methodsAreTopLevel?: boolean;
  interfaceKind?: NodeKind;

  // --- New hooks ---
  visitNode?: (node: SyntaxNode, ctx: ExtractorContext) => boolean;
  classifyClassNode?: (node: SyntaxNode) => 'class' | 'struct' | 'enum' | 'interface' | 'trait';
  resolveBody?: (node: SyntaxNode, bodyField: string) => SyntaxNode | null;
  extractImport?: (node: SyntaxNode, source: string) => ImportInfo | null;
  // One entry per imported module, for statements that import several
  // (`import a, b as c`). Takes precedence over extractImport.
  extractImports?: (node: SyntaxNode, source: string) => ImportInfo[];
  extractVariables?: (node: SyntaxNode, source: string) => VariableInfo[];
  getReceiverType?: (node: SyntaxNode, source: string) => string | undefined;
  resolveTypeAliasKind?: (node: SyntaxNode, source: string) => NodeKind | undefined;
  isMisparsedFunction?: (name: string, node: SyntaxNode) => boolean;
  extractBareCall?: (node: SyntaxNode, source: string) => string | undefined;
}
