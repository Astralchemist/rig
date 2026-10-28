// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
// Source: src/extraction/languages/python.ts (import paths rewired; Rig's
// extractImports replaces extractImport to cover `import x` / `import x as y`).

import { getChildByField, getNodeText } from '../tree-sitter-helpers.ts';
import type { ImportInfo, LanguageExtractor } from '../tree-sitter-types.ts';

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
  isAsync: (node) => {
    const prev = node.previousSibling;
    return prev?.type === 'async';
  },
  isStatic: (node) => {
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  // `from x import y` → x. `import a.b, c as d` → a.b and c (alias 'd').
  extractImports: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (!moduleNode) return [];
      return [{ moduleName: getNodeText(moduleNode, source), signature: importText }];
    }
    const out: ImportInfo[] = [];
    for (const name of node.childrenForFieldName('name')) {
      const aliased = name?.type === 'aliased_import';
      const moduleNode = aliased ? name.childForFieldName('name') : name;
      if (!moduleNode) continue;
      const alias = aliased ? name.childForFieldName('alias') : null;
      out.push({
        moduleName: getNodeText(moduleNode, source),
        signature: importText,
        ...(alias ? { alias: getNodeText(alias, source) } : {}),
      });
    }
    return out;
  },
};
