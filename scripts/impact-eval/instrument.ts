// SPDX-License-Identifier: Apache-2.0
// Source-to-source instrumentation for the E5 evaluation's oracle: a call to
// `__rigCall(file, line)` at the start of every function body, so a test run
// records who actually calls whom (dynamic call edges).
//
// Everything is inserted on the line it lands on, never with a newline, so
// line numbers in stack traces and in the index still agree: the caller is
// read from the stack, and both sides are mapped to symbols by line.
import { getParser } from '../../packages/core/src/extract/grammars.ts';
import { detectLanguage } from '../../packages/core/src/extract/grammars.ts';

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

interface Edit {
  at: number; // byte offset in the source
  text: string;
}

type TSNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  childForFieldName(name: string): TSNode | null;
  namedChildren: TSNode[];
};

type Parser = NonNullable<Awaited<ReturnType<typeof getParser>>>;
const LANGS = ['typescript', 'tsx', 'javascript', 'jsx'] as const;
const parsers = new Map<string, Parser>();

/** Load the grammars once, so instrumentation itself can run synchronously (Bun's onLoad must stay sync). */
export const loadParsers = async (): Promise<void> => {
  for (const l of LANGS) {
    const p = await getParser(l);
    if (p) parsers.set(l, p);
  }
};

/** `source` with a `__rigCall` probe at the start of each function; null when it can't be parsed. Call loadParsers first. */
export const instrumentSourceSync = (path: string, source: string): string | null => {
  const parser = parsers.get(detectLanguage(path));
  if (!parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null;
  const file = JSON.stringify(path);
  const edits: Edit[] = [];
  const visit = (n: TSNode): void => {
    if (FUNCTION_TYPES.has(n.type)) {
      const body = n.childForFieldName('body');
      const line = n.startPosition.row + 1;
      const probe = `__rigCall(${file},${line})`;
      if (body?.type === 'statement_block') {
        edits.push({ at: body.startIndex + 1, text: `${probe};` });
      } else if (body) {
        // Expression-bodied arrow: (probe, expr), same value, same lines.
        edits.push({ at: body.startIndex, text: `(${probe},` });
        edits.push({ at: body.endIndex, text: `)` });
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode as unknown as TSNode);
  tree.delete?.();
  if (!edits.length) return source;
  // web-tree-sitter's JS binding reports offsets in UTF-16 code units, the
  // same units as JS string indices.
  edits.sort((x, y) => y.at - x.at);
  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
};

export const instrumentSource = async (path: string, source: string): Promise<string | null> => {
  if (!parsers.size) await loadParsers();
  return instrumentSourceSync(path, source);
};
