// SPDX-License-Identifier: Apache-2.0
type JsonObj = Record<string, unknown>;

const isObj = (v: unknown): v is JsonObj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export interface MergeOptions {
  // Array paths (e.g. ['permissions', 'allow']) merged as a de-duplicated
  // union instead of being replaced.
  union?: (path: readonly string[]) => boolean;
}

// Existing entries first, in their order, then the new ones; exact duplicates
// (by JSON value) collapse to their first occurrence.
export const uniqueUnion = (base: readonly unknown[], overlay: readonly unknown[]): unknown[] => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of [...base, ...overlay]) {
    const key = JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
};

// Recursive merge: object keys merge, anything else (arrays, primitives) is
// replaced by overlay — unless opts.union claims the array's path. Preserves
// user-added sibling keys at every depth.
export const deepMerge = (
  base: unknown,
  overlay: unknown,
  opts: MergeOptions = {},
  path: readonly string[] = [],
): unknown => {
  if (Array.isArray(base) && Array.isArray(overlay) && opts.union?.(path)) {
    return uniqueUnion(base, overlay);
  }
  if (!isObj(base) || !isObj(overlay)) return overlay;
  const out: JsonObj = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = Object.hasOwn(base, k) ? deepMerge(base[k], v, opts, [...path, k]) : v;
  }
  return out;
};

// Permission files (role 'permissions'): every list under `permissions`
// (allow / ask / deny) is unioned, so a re-install adds rig's new entries
// without dropping ones the user added (#8).
export const permissionsUnion = (path: readonly string[]): boolean => path[0] === 'permissions';

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
