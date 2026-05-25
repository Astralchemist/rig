// SPDX-License-Identifier: Apache-2.0
type JsonObj = Record<string, unknown>;

const isObj = (v: unknown): v is JsonObj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Recursive merge: object keys merge, anything else (arrays, primitives) is
// replaced by overlay. Preserves user-added sibling keys at every depth.
export const deepMerge = (base: unknown, overlay: unknown): unknown => {
  if (!isObj(base) || !isObj(overlay)) return overlay;
  const out: JsonObj = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  }
  return out;
};

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
