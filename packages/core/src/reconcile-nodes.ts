// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Node as ExtractNode } from './extract/upstream-types.ts';

// Reconcile a file's freshly extracted nodes with the nodes stored for it, so
// a re-extract updates rows in place instead of purging and re-inserting them.
// Code ids are position-keyed (kind:sha256(file:kind:name:line)), so without
// this a one-line shift gave a symbol a new id and orphaned everything that
// referenced the old one.
//
// Matching, in order:
//  1. (kind, qualifiedName, ordinal among equal (kind, qualifiedName) ordered
//     by start position). A matched node keeps its stored id.
//  2. Among the nodes still unmatched, equal generated ids: the extractor's own
//     identity, e.g. a declared dependency whose spec (and so qualifiedName)
//     changed, or a method whose class was renamed on the same line.
// Unmatched new nodes keep their generated id unless another node of the
// file holds it (or anything else in the DB does); then the id is re-hashed
// deterministically in the same `prefix:32-hex` format. Unmatched stored nodes
// are removed.

export interface StoredNode {
  id: string;
  kind: string;
  qualifiedName: string;
  startLine: number;
  startColumn: number;
}

export interface ReconciledNode {
  // The extracted node with its final id.
  node: ExtractNode;
  // Stored row it updates, or null when it is inserted.
  storedId: string | null;
}

export interface Reconciliation {
  nodes: ReconciledNode[];
  removed: StoredNode[];
  // Generated id → final id, for rewriting the file's edges and refs.
  idMap: Map<string, string>;
}

const keyOf = (kind: string, qualifiedName: string): string => `${kind}\u0000${qualifiedName}`;

const reHash = (id: string, salt: number): string => {
  const colon = id.indexOf(':');
  const prefix = colon > 0 ? id.slice(0, colon) : 'node';
  const hash = createHash('sha256').update(`${id}#${salt}`).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
};

export const reconcileNodes = (
  stored: readonly StoredNode[],
  extracted: readonly ExtractNode[],
  // Is this id held by a node outside `stored`?
  isTakenElsewhere: (id: string) => boolean,
): Reconciliation => {
  const storedByKey = new Map<string, StoredNode[]>();
  for (const s of stored) {
    const k = keyOf(s.kind, s.qualifiedName);
    const arr = storedByKey.get(k);
    if (arr) arr.push(s);
    else storedByKey.set(k, [s]);
  }
  for (const arr of storedByKey.values()) {
    arr.sort(
      (a, b) =>
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  const freshByKey = new Map<string, number[]>();
  extracted.forEach((n, i) => {
    const k = keyOf(n.kind, n.qualifiedName);
    const arr = freshByKey.get(k);
    if (arr) arr.push(i);
    else freshByKey.set(k, [i]);
  });

  // 1. key + ordinal
  const matchOf: (StoredNode | null)[] = extracted.map(() => null);
  const claimed = new Set<string>();
  for (const [k, idxs] of freshByKey) {
    const candidates = storedByKey.get(k);
    if (!candidates) continue;
    // toSorted is stable, so equal positions keep extraction order.
    const ordered = idxs.toSorted(
      (a, b) =>
        extracted[a]!.startLine - extracted[b]!.startLine ||
        extracted[a]!.startColumn - extracted[b]!.startColumn,
    );
    for (let o = 0; o < ordered.length && o < candidates.length; o++) {
      matchOf[ordered[o]!] = candidates[o]!;
      claimed.add(candidates[o]!.id);
    }
  }

  // 2. equal generated id among the leftovers
  const leftoverById = new Map<string, StoredNode>();
  for (const s of stored) if (!claimed.has(s.id)) leftoverById.set(s.id, s);
  extracted.forEach((n, i) => {
    if (matchOf[i]) return;
    const s = leftoverById.get(n.id);
    if (!s) return;
    matchOf[i] = s;
    claimed.add(s.id);
    leftoverById.delete(s.id);
  });

  // Final ids. Stored ids (matched or about to be removed) are never handed to
  // a different symbol, so stale references to a removed node cannot silently
  // resolve to a new one.
  const storedIds = new Set(stored.map((s) => s.id));
  const assigned = new Set<string>(claimed);
  const idMap = new Map<string, string>();
  const nodes: ReconciledNode[] = extracted.map((n, i) => {
    const match = matchOf[i];
    let id: string;
    if (match) {
      id = match.id;
    } else {
      id = n.id;
      for (let salt = 1; assigned.has(id) || storedIds.has(id) || isTakenElsewhere(id); salt++) {
        id = reHash(n.id, salt);
      }
      assigned.add(id);
    }
    if (!idMap.has(n.id)) idMap.set(n.id, id);
    return { node: id === n.id ? n : { ...n, id }, storedId: match ? match.id : null };
  });

  const removed = stored.filter((s) => !claimed.has(s.id));
  return { nodes, removed, idMap };
};
