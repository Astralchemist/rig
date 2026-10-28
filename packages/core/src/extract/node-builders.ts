// SPDX-License-Identifier: Apache-2.0
import { Node as SyntaxNode } from 'web-tree-sitter';
import { generateNodeId, getChildByField } from './tree-sitter-helpers.ts';
import type { LanguageExtractor } from './tree-sitter-types.ts';
import type { Language, Node, NodeKind } from './upstream-types.ts';

export const makeFileNode = (id: string, filePath: string, language: Language): Node => ({
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

export const fileIdOf = (filePath: string): string => generateNodeId(filePath, 'file', filePath, 0);

// `inClass`: the nearest enclosing declaration is a class. A node type listed
// as both function and method (Python's function_definition) is a method only
// directly in a class body; nested in a function or method it is a function.
export const declKindOf = (
  type: string,
  ex: LanguageExtractor,
  inClass = false,
): NodeKind | null => {
  if (ex.classTypes.includes(type)) return 'class';
  if (ex.interfaceTypes.includes(type)) return ex.interfaceKind ?? 'interface';
  if (ex.structTypes.includes(type)) return 'struct';
  if (ex.enumTypes.includes(type)) return 'enum';
  if (ex.typeAliasTypes.includes(type)) return 'type_alias';
  const isFunction = ex.functionTypes.includes(type);
  if (ex.methodTypes.includes(type) && (inClass || !isFunction)) return 'method';
  if (isFunction) return 'function';
  return null;
};

export const nameFor = (node: SyntaxNode, ex: LanguageExtractor): string | null =>
  getChildByField(node, ex.nameField)?.text ?? null;

// The node a declaration's doc comment sits above: `/** … */ export function f`
// documents f, but the comment is a sibling of the export statement.
export const docAnchorOf = (node: SyntaxNode): SyntaxNode =>
  node.parent?.type === 'export_statement' ? node.parent : node;

export const calleeNameOf = (callNode: SyntaxNode): string | null => {
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
