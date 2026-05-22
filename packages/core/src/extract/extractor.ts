import { Node as SyntaxNode } from 'web-tree-sitter';
import { detectLanguage, getParser } from './grammars.ts';
import { EXTRACTORS } from './languages/index.ts';
import { extractMarkdown } from './markdown.ts';
import { generateNodeId, getChildByField, getNodeText, getPrecedingDocstring } from './tree-sitter-helpers.ts';
import type { LanguageExtractor } from './tree-sitter-types.ts';
import type { ExtractionResult, Language, Node, NodeKind } from './upstream-types.ts';

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

  const nodes: Node[] = [];
  const scope: string[] = [];
  walk(tree.rootNode, { extractor, filePath, language, nodes, scope, source });
  return { nodes, edges: [], unresolvedReferences: [], errors: [], durationMs: Date.now() - start };
}

interface WalkCtx {
  extractor: LanguageExtractor;
  filePath: string;
  language: Language;
  nodes: Node[];
  scope: string[];
  source: string;
}

const kindOf = (type: string, ex: LanguageExtractor): NodeKind | null => {
  if (ex.classTypes.includes(type)) return 'class';
  if (ex.interfaceTypes.includes(type)) return ex.interfaceKind ?? 'interface';
  if (ex.structTypes.includes(type)) return 'struct';
  if (ex.enumTypes.includes(type)) return 'enum';
  if (ex.typeAliasTypes.includes(type)) return 'type_alias';
  if (ex.methodTypes.includes(type)) return 'method';
  if (ex.functionTypes.includes(type)) return 'function';
  if (ex.importTypes.includes(type)) return 'import';
  return null;
};

function nameFor(node: SyntaxNode, ex: LanguageExtractor): string | null {
  const named = getChildByField(node, ex.nameField);
  if (named) return named.text;
  return null;
}

function walk(node: SyntaxNode, ctx: WalkCtx): void {
  const kind = kindOf(node.type, ctx.extractor);
  if (kind) {
    const name = nameFor(node, ctx.extractor);
    if (name) {
      const id = generateNodeId(ctx.filePath, kind, name, node.startPosition.row + 1);
      const qn = ctx.scope.length ? `${ctx.scope.join('.')}.${name}` : name;
      const signature = ctx.extractor.getSignature?.(node, ctx.source);
      const docstring = getPrecedingDocstring(node, ctx.source);
      const out: Node = {
        id,
        kind,
        name,
        qualifiedName: qn,
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
      };
      ctx.nodes.push(out);
      const recurseIntoBody = kind === 'class' || kind === 'interface' || kind === 'enum';
      if (recurseIntoBody) {
        ctx.scope.push(name);
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c) walk(c, ctx);
        }
        ctx.scope.pop();
        return;
      }
      return;
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) walk(c, ctx);
  }
}

export type { ExtractionResult, Node } from './upstream-types.ts';
