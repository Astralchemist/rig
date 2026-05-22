import { Node as SyntaxNode } from 'web-tree-sitter';
import { calleeNameOf, declKindOf, nameFor } from './node-builders.ts';
import { generateNodeId, getPrecedingDocstring } from './tree-sitter-helpers.ts';
import type { LanguageExtractor } from './tree-sitter-types.ts';
import type { Language, Node, UnresolvedReference } from './upstream-types.ts';

interface ScopeFrame {
  id: string;
  name: string;
}

export interface VisitCtx {
  extractor: LanguageExtractor;
  filePath: string;
  language: Language;
  nodes: Node[];
  refs: UnresolvedReference[];
  scope: ScopeFrame[];
  source: string;
}

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
    const info = ctx.extractor.extractImport?.(node, ctx.source);
    if (info?.moduleName) {
      ctx.refs.push({
        fromNodeId: ctx.scope[0]!.id,
        referenceName: info.moduleName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        filePath: ctx.filePath,
        language: ctx.language,
      });
    }
  }

  const kind = declKindOf(node.type, ctx.extractor);
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
      ctx.scope.push({ id, name });
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
