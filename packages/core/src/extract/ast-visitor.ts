// SPDX-License-Identifier: Apache-2.0
import { Node as SyntaxNode } from 'web-tree-sitter';
import {
  calleeNameOf,
  declKindOf,
  docAnchorOf,
  functionBindingOf,
  nameFor,
} from './node-builders.ts';
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
const HERITAGE_NODE_TYPES = new Set(['extends_clause', 'extends_type_clause', 'implements_clause']);
// Inside heritage, tree-sitter uses plain `identifier` for class extends and
// `type_identifier` for interface extends / implements. Walk both.
const HERITAGE_TARGET_TYPES = new Set(['type_identifier', 'identifier']);

// Nodes whose children are values: call arguments (TS/JS `arguments`,
// Python `argument_list`), object pairs and arrays.
const VALUE_HOLDER_TYPES = new Set(['arguments', 'argument_list', 'pair', 'array', 'list']);
const WRAPPER_TYPES = new Set([
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'parenthesized_expression',
  'type_assertion',
]);

const pushReference = (node: SyntaxNode, ctx: VisitCtx, kind: EdgeKind): void => {
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

const pushHeritageRefs = (node: SyntaxNode, ctx: VisitCtx, kind: EdgeKind): void => {
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
        ...(info.importedNames !== undefined ? { importedNames: info.importedNames } : {}),
      });
    }
  }

  // Heritage clauses → 'extends' or 'implements'. Walk subtree for any
  // identifier or type_identifier and return early so they don't double-count
  // as plain 'references'.
  if (HERITAGE_NODE_TYPES.has(node.type)) {
    const heritageKind: EdgeKind = node.type === 'implements_clause' ? 'implements' : 'extends';
    pushHeritageRefs(node, ctx, heritageKind);
    return;
  }

  // A name used as a value: a function passed as an argument (`retry(save)`,
  // `on('change', this.sync)`), placed in a dispatch table (`{ save }`,
  // `{ x: save }`, `[save, load]`). The call happens elsewhere, so without
  // this the graph has no link between the two; resolution is by name, like
  // calls. Traversal continues below.
  if (VALUE_HOLDER_TYPES.has(node.type)) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!c) continue;
      let v = node.type === 'pair' ? (c === node.childForFieldName('value') ? c : null) : c;
      // Look through casts and wrappers: `save as Handler`, `save!`, `(save)`.
      while (v && WRAPPER_TYPES.has(v.type)) v = v.namedChild(0);
      if (!v) continue;
      if (v.type === 'identifier') pushReference(v, ctx, 'references');
      else if (v.type === 'member_expression' && v.childForFieldName('object')?.type === 'this') {
        const prop = v.childForFieldName('property');
        if (prop) pushReference(prop, ctx, 'references');
      }
    }
  }
  if (node.type === 'shorthand_property_identifier') pushReference(node, ctx, 'references');

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
      // A bound function (`const f = () => {}`) spans its declarator, `f = …`.
      const span = functionBindingOf(node) ?? node;
      const id = generateNodeId(ctx.filePath, kind, name, span.startPosition.row + 1);
      const qn = ctx.scope
        .slice(1)
        .map((s) => s.name)
        .concat(name)
        .join('.');
      const signature = ctx.extractor.getSignature?.(node, ctx.source);
      const docstring = getPrecedingDocstring(docAnchorOf(span), ctx.source);
      ctx.nodes.push({
        id,
        kind,
        name,
        qualifiedName: qn || name,
        filePath: ctx.filePath,
        language: ctx.language,
        startLine: span.startPosition.row + 1,
        endLine: span.endPosition.row + 1,
        startColumn: span.startPosition.column,
        endColumn: span.endPosition.column,
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
