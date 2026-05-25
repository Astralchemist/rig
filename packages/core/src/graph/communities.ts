// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';

// Label-propagation community detection. Cheap (O(E) per iteration), no LLM,
// deterministic for a fixed seed. Not as accurate as Leiden but good enough
// for visual clustering of the constellation. Lands as A4-lite per the
// iteration backlog; Leiden + community summaries land in A4-full / G3.
//
// Algorithm:
//   1. Each node starts with its own label (the node id index).
//   2. For each node in (seeded-random) order, adopt the label most common
//      among its undirected neighbors. Ties broken by lowest label.
//   3. Repeat until no node changes label, capped at MAX_ITERS.
//
// We then renumber labels into a dense 0..K range and persist per-node.

const MAX_ITERS = 16;

interface EdgePair {
  src: string;
  dst: string;
}

const seededShuffle = <T>(arr: T[], seed: number): T[] => {
  // Mulberry32 — deterministic, plenty good for shuffle order.
  let s = seed >>> 0;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const j = Math.floor(r * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

export const detectCommunities = (db: SqliteAdapter, seed = 1): number => {
  const nodes = db.prepare(`SELECT id FROM nodes`).all() as { id: string }[];
  if (nodes.length === 0) return 0;
  const edges = db
    .prepare(`SELECT src, dst FROM edges WHERE kind IN ('contains','references','calls','imports','extends','implements')`)
    .all() as EdgePair[];

  // Build undirected adjacency list.
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.src)?.push(e.dst);
    adj.get(e.dst)?.push(e.src);
  }

  // label[id] = current community label.
  const label = new Map<string, string>();
  for (const n of nodes) label.set(n.id, n.id);

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const order = seededShuffle(nodes, seed + iter);
    let changed = 0;
    for (const node of order) {
      const neighbors = adj.get(node.id);
      if (!neighbors || neighbors.length === 0) continue;
      const counts = new Map<string, number>();
      for (const nb of neighbors) {
        const lab = label.get(nb)!;
        counts.set(lab, (counts.get(lab) ?? 0) + 1);
      }
      // Pick the label with the highest count; tie-break by lowest id.
      let bestLabel = label.get(node.id)!;
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < bestLabel)) {
          bestLabel = l;
          bestCount = c;
        }
      }
      if (bestLabel !== label.get(node.id)) {
        label.set(node.id, bestLabel);
        changed++;
      }
    }
    if (changed === 0) break;
  }

  // Renumber into dense 0..K-1 by sorted label string for stable IDs.
  const uniqueLabels = Array.from(new Set(label.values())).sort();
  const labelToIdx = new Map(uniqueLabels.map((l, i) => [l, i]));

  db.transaction(() => {
    const upd = db.prepare(`UPDATE nodes SET community_id = ? WHERE id = ?`);
    for (const [nodeId, lab] of label) upd.run(labelToIdx.get(lab)!, nodeId);
  })();

  return uniqueLabels.length;
};
