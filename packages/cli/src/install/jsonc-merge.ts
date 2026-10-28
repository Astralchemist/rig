// SPDX-License-Identifier: Apache-2.0
import { applyEdits, modify, parse } from 'jsonc-parser';

type Path = (string | number)[];
type Leaf = { path: Path; value: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Walk a template into leaf-path / leaf-value pairs. Arrays and primitives
// count as leaves; only plain objects are recursed into. Lets the writer
// preserve user siblings at any depth via separate per-path modify() calls.
export const flattenPaths = (obj: unknown, prefix: Path = []): Leaf[] => {
  if (!isPlainObject(obj)) return [{ path: prefix, value: obj }];
  const out: Leaf[] = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(...flattenPaths(v, [...prefix, k]));
  }
  return out;
};

const valueAt = (doc: unknown, path: Path): unknown => {
  let cur = doc;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[String(key)];
  }
  return cur;
};

// `pick` chooses what to write at a leaf that already holds a value (by
// default the template's value wins).
export const mergeJsonc = (
  existing: string,
  template: unknown,
  pick?: (existing: unknown, incoming: unknown) => unknown,
): string => {
  const text = existing.trim() ? existing : '{}\n';
  const doc = pick ? (parse(text) as unknown) : undefined;
  let result = text;
  for (const { path, value } of flattenPaths(template)) {
    const current = pick ? valueAt(doc, path) : undefined;
    const next = pick && current !== undefined ? pick(current, value) : value;
    const edits = modify(result, path, next, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    result = applyEdits(result, edits);
  }
  return result;
};

// opencode accepts `"permission": "ask"` as shorthand for `{ "*": "ask" }`.
// Before adding per-key entries under such a key, expand the shorthand into
// that object so it keeps meaning the same for everything else.
export const expandScalarShorthands = (existing: string, template: unknown): string => {
  if (!isPlainObject(template) || !existing.trim()) return existing;
  const doc = parse(existing) as unknown;
  if (!isPlainObject(doc)) return existing;
  let result = existing;
  for (const [key, value] of Object.entries(template)) {
    const current = doc[key];
    if (isPlainObject(value) && typeof current === 'string') {
      const edits = modify(result, [key], { '*': current }, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      });
      result = applyEdits(result, edits);
    }
  }
  return result;
};
