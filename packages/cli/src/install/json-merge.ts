// SPDX-License-Identifier: Apache-2.0
import { isRigListEntry } from './ownership.ts';

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

// Lists under `permissions` (allow / ask / deny …) merge as a union.
export const permissionsUnion = (path: readonly string[]): boolean => path[0] === 'permissions';

// Permission files (role 'permissions', #8). rig's current policy is
// authoritative for rig-owned entries: each ends up in exactly the list the
// policy puts it in and is dropped from every other one, so an upgrade that
// moves a tool from allow to ask doesn't leave it in both; rig-owned entries
// the policy no longer lists go too. Everything else is the user's and stays
// where it is; rig's missing entries are appended and duplicates collapse.
export const mergePermissions = (base: unknown, policy: unknown): unknown => {
  const merged = deepMerge(base, policy, { union: permissionsUnion });
  if (!isObj(merged) || !isObj(merged.permissions) || !isObj(policy) || !isObj(policy.permissions)) {
    return merged;
  }
  const listOf = new Map<string, string>();
  for (const [list, entries] of Object.entries(policy.permissions)) {
    if (Array.isArray(entries)) for (const e of entries) listOf.set(JSON.stringify(e), list);
  }
  const permissions = merged.permissions;
  for (const [list, entries] of Object.entries(permissions)) {
    if (!Array.isArray(entries)) continue;
    permissions[list] = entries.filter((e) => !isRigListEntry(e) || listOf.get(JSON.stringify(e)) === list);
  }
  return merged;
};

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
