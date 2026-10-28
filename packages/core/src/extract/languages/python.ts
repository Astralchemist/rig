// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
// Source: src/extraction/languages/python.ts (import paths rewired; Rig's
// extractImports replaces extractImport to cover `import x` / `import x as y`,
// and isAsync is fixed for this grammar).

import { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers.ts';
import type { LanguageExtractor } from '../tree-sitter-types.ts';

// The entries of an import list (`a.b, c as d`) as [name, alias] pairs.
const importList = (node: SyntaxNode): Array<[SyntaxNode, SyntaxNode | null]> => {
  const out: Array<[SyntaxNode, SyntaxNode | null]> = [];
  for (const entry of node.childrenForFieldName('name')) {
    if (entry?.type !== 'aliased_import') {
      if (entry) out.push([entry, null]);
      continue;
    }
    const name = entry.childForFieldName('name');
    if (name) out.push([name, entry.childForFieldName('alias')]);
  }
  return out;
};

export const pythonExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  // `async` is the definition's own first token, not a preceding sibling.
  isAsync: (node) => node.firstChild?.type === 'async',
  isStatic: (node) => {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  // `import a.b, c as d` → a.b and c (alias 'd'). `from x import y, z` → x,
  // importing y and z (each possibly a submodule of x; `*` imports none).
  extractImports: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (!moduleNode) return [];
      const importedNames = importList(node).map(([name]) => getNodeText(name, source));
      return [
        {
          moduleName: getNodeText(moduleNode, source),
          signature: importText,
          ...(importedNames.length > 0 ? { importedNames } : {}),
        },
      ];
    }
    return importList(node).map(([name, alias]) => ({
      moduleName: getNodeText(name, source),
      signature: importText,
      ...(alias ? { alias: getNodeText(alias, source) } : {}),
    }));
  },
};
