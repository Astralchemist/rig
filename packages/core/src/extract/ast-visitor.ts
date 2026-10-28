// SPDX-License-Identifier: Apache-2.0
import { Node as SyntaxNode } from 'web-tree-sitter';
import { calleeNameOf, declKindOf, nameFor } from './node-builders.ts';
import { generateNodeId, getPrecedingDocstring } from './tree-sitter-helpers.ts';
import type { LanguageExtractor } from './tree-sitter-types.ts';
import type {
  Edge,
  EdgeKind,
  Language,
  Node,
  NodeKind,
  UnresolvedReference,
} from './upstream-types.ts';

interface ScopeFrame {
  id: string;
  name: string;
  kind: NodeKind;
}

export interface VisitCtx {
  extractor: LanguageExtractor;
  filePath: string;
  language: Language;
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
  scope: ScopeFrame[];
  source: string;
}

const TYPE_IDENT_NODE_TYPES = new Set(['type_identifier']);
// extends_clause: `class C extends B`. extends_type_clause: `interface I extends J`.
const HERITAGE_NODE_TYPES = new Set([
  'extends_clause',
  'extends_type_clause',
  'implements_clause',
]);
// Inside heritage, tree-sitter uses plain `identifier` for class extends and
// `type_identifier` for interface extends / implements. Walk both.
const HERITAGE_TARGET_TYPES = new Set(['type_identifier', 'identifier']);

const pushReference = (
  node: SyntaxNode,
  ctx: VisitCtx,
  kind: EdgeKind,
): void => {
  const owner = ctx.scope[ctx.scope.length - 1];
  if (!owner) return;
  ctx.refs.push({
    fromNodeId: owner.id,
    referenceName: node.text,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    filePath: ctx.filePath,
    language: ctx.language,
  });
};

const pushHeritageRefs = (
  node: SyntaxNode,
  ctx: VisitCtx,
  kind: EdgeKind,
): void => {
  if (HERITAGE_TARGET_TYPES.has(node.type)) {
    pushReference(node, ctx, kind);
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) pushHeritageRefs(c, ctx, kind);
  }
};

export function visit(node: SyntaxNode, ctx: VisitCtx): void {
  if (ctx.extractor.callTypes.includes(node.type)) {
    const callee = calleeNameOf(node);
    if (callee) {
      ctx.refs.push({
        fromNodeId: ctx.scope[ctx.scope.length - 1]!.id,
        referenceName: callee,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        filePath: ctx.filePath,
        language: ctx.language,
      });
    }
  }
  if (ctx.extractor.importTypes.includes(node.type)) {
    const infos = ctx.extractor.extractImports
      ? ctx.extractor.extractImports(node, ctx.source)
      : [ctx.extractor.extractImport?.(node, ctx.source)];
    for (const info of infos) {
      if (!info?.moduleName) continue;
      ctx.refs.push({
        fromNodeId: ctx.scope[0]!.id,
        referenceName: info.moduleName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        filePath: ctx.filePath,
        language: ctx.language,
        ...(info.alias !== undefined ? { alias: info.alias } : {}),
      });
    }
  }

  // Heritage clauses → 'extends' or 'implements'. Walk subtree for any
  // identifier or type_identifier and return early so they don't double-count
  // as plain 'references'.
  if (HERITAGE_NODE_TYPES.has(node.type)) {
    const heritageKind: EdgeKind =
      node.type === 'implements_clause' ? 'implements' : 'extends';
    pushHeritageRefs(node, ctx, heritageKind);
    return;
  }

  // Type identifiers anywhere else (parameter types, return types, generics).
  if (TYPE_IDENT_NODE_TYPES.has(node.type)) {
    pushReference(node, ctx, 'references');
    return;
  }

  const enclosing = ctx.scope[ctx.scope.length - 1];
  const kind = declKindOf(node.type, ctx.extractor, enclosing?.kind === 'class');
  if (kind) {
    const name = nameFor(node, ctx.extractor);
    if (name) {
      const id = generateNodeId(ctx.filePath, kind, name, node.startPosition.row + 1);
      const qn = ctx.scope.slice(1).map((s) => s.name).concat(name).join('.');
      const signature = ctx.extractor.getSignature?.(node, ctx.source);
      const docstring = getPrecedingDocstring(node, ctx.source);
      ctx.nodes.push({
        id,
        kind,
        name,
        qualifiedName: qn || name,
        filePath: ctx.filePath,
        language: ctx.language,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        ...(docstring !== undefined ? { docstring } : {}),
        ...(signature !== undefined ? { signature } : {}),
        isExported: ctx.extractor.isExported?.(node, ctx.source) ?? false,
        isAsync: ctx.extractor.isAsync?.(node) ?? false,
        isStatic: ctx.extractor.isStatic?.(node) ?? false,
        updatedAt: Date.now(),
      });
      // Direct `contains` edge from the enclosing scope to this declaration.
      if (enclosing) {
        ctx.edges.push({ source: enclosing.id, target: id, kind: 'contains' });
      }
      ctx.scope.push({ id, name, kind });
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c) visit(c, ctx);
      }
      ctx.scope.pop();
      return;
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) visit(c, ctx);
  }
}
