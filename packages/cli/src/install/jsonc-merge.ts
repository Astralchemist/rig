import { applyEdits, modify } from 'jsonc-parser';

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

export const mergeJsonc = (existing: string, template: unknown): string => {
  const text = existing.trim() ? existing : '{}\n';
  let result = text;
  for (const { path, value } of flattenPaths(template)) {
    const edits = modify(result, path, value, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    result = applyEdits(result, edits);
  }
  return result;
};
