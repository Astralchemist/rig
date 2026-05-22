import { Node as SyntaxNode } from 'web-tree-sitter';
import { detectLanguage, getParser } from './grammars.ts';
import { EXTRACTORS } from './languages/index.ts';
import { extractMarkdown } from './markdown.ts';
import {
  generateNodeId,
  getChildByField,
  getPrecedingDocstring,
} from './tree-sitter-helpers.ts';
import type { LanguageExtractor } from './tree-sitter-types.ts';
import type {
  ExtractionResult,
  Language,
  Node,
  NodeKind,
  UnresolvedReference,
} from './upstream-types.ts';

export async function extractFromSource(
  filePath: string,
  source: string,
  langOverride?: Language,
): Promise<ExtractionResult> {
  const start = Date.now();
  const language = langOverride ?? detectLanguage(filePath);
  const empty: ExtractionResult = {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 0,
  };

  if (language === 'markdown') {
    return { ...extractMarkdown(filePath, source), durationMs: Date.now() - start };
  }

  const parser = await getParser(language);
  const extractor = EXTRACTORS[language];
  if (!parser || !extractor) return { ...empty, durationMs: Date.now() - start };

  const tree = parser.parse(source);
  if (!tree) return { ...empty, durationMs: Date.now() - start };

  const fileId = generateNodeId(filePath, 'file', filePath, 0);
  const nodes: Node[] = [makeFileNode(fileId, filePath, language)];
  const refs: UnresolvedReference[] = [];
  walk(tree.rootNode, {
    extractor,
    filePath,
    language,
    nodes,
    refs,
    scope: [{ id: fileId, name: filePath }],
    source,
  });
  return {
    nodes,
    edges: [],
    unresolvedReferences: refs,
    errors: [],
    durationMs: Date.now() - start,
  };
}

const makeFileNode = (id: string, filePath: string, language: Language): Node => ({
  id,
  kind: 'file',
  name: filePath,
  qualifiedName: filePath,
  filePath,
  language,
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 0,
  updatedAt: Date.now(),
});

interface ScopeFrame {
  id: string;
  name: string;
}

interface WalkCtx {
  extractor: LanguageExtractor;
  filePath: string;
  language: Language;
  nodes: Node[];
  refs: UnresolvedReference[];
  scope: ScopeFrame[];
  source: string;
}

const declKindOf = (type: string, ex: LanguageExtractor): NodeKind | null => {
  if (ex.classTypes.includes(type)) return 'class';
  if (ex.interfaceTypes.includes(type)) return ex.interfaceKind ?? 'interface';
  if (ex.structTypes.includes(type)) return 'struct';
  if (ex.enumTypes.includes(type)) return 'enum';
  if (ex.typeAliasTypes.includes(type)) return 'type_alias';
  if (ex.methodTypes.includes(type)) return 'method';
  if (ex.functionTypes.includes(type)) return 'function';
  return null;
};

const nameFor = (node: SyntaxNode, ex: LanguageExtractor): string | null => {
  return getChildByField(node, ex.nameField)?.text ?? null;
};

const calleeNameOf = (callNode: SyntaxNode): string | null => {
  const fn = getChildByField(callNode, 'function') ?? callNode.namedChild(0);
  if (!fn) return null;
  if (fn.type === 'identifier' || fn.type === 'property_identifier') return fn.text;
  // member_expression / attribute (a.b()) — rightmost identifier
  for (let i = fn.namedChildCount - 1; i >= 0; i--) {
    const c = fn.namedChild(i);
    if (c?.type === 'property_identifier' || c?.type === 'identifier') return c.text;
  }
  return null;
};

function walk(node: SyntaxNode, ctx: WalkCtx): void {
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
        fromNodeId: ctx.scope[0]!.id, // file is always scope[0]
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
      const qn = `${ctx.scope.map((s) => s.name).slice(1).concat(name).join('.')}`;
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
        if (c) walk(c, ctx);
      }
      ctx.scope.pop();
      return;
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walk(c, ctx);
  }
}

export type { ExtractionResult, Node, UnresolvedReference } from './upstream-types.ts';
