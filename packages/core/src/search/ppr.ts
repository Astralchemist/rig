// SPDX-License-Identifier: Apache-2.0
// Personalised PageRank re-ranking (research roadmap, step 3): relevance
// spreads from the search's best hits through the code graph, so code that
// sits next to several good hits rises, and hubs are damped so that being
// connected to everything doesn't count as being relevant.
//
// Parameters are fixed in advance (see the retrieval evaluation's
// pre-registration): teleport 0.15, 20 iterations, the top 20 hits as seeds
// weighted by their fused score, a final score that is half the normalised
// search score and half the normalised PageRank divided by degree
// (degree-normalised PageRank: a hub's leaves feed its rank straight back).
import type { SqliteAdapter } from '../db/adapter.ts';

export const PPR_DEFAULTS = { alpha: 0.15, iterations: 20, seeds: 20, mix: 0.5 } as const;

const DEPENDENCY_KINDS = ['calls', 'references', 'imports', 'extends', 'implements', 'contains'];

const adjacency = (db: SqliteAdapter): Map<string, string[]> => {
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string): void => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  const rows = db
    .prepare(
      `SELECT src, dst FROM edges WHERE kind IN (${DEPENDENCY_KINDS.map(() => '?').join(', ')})`,
    )
    .all(...DEPENDENCY_KINDS) as { src: string; dst: string }[];
  for (const r of rows) {
    if (r.src === r.dst) continue;
    add(r.src, r.dst);
    add(r.dst, r.src);
  }
  return adj;
};

/** Hits re-ranked by search score and personalised PageRank from them; may bring in nodes the search didn't return. */
export const pprRerank = (
  db: SqliteAdapter,
  hits: readonly { id: string; score: number }[],
  opts: Partial<typeof PPR_DEFAULTS> = {},
): { id: string; score: number }[] => {
  const { alpha, iterations, seeds, mix } = { ...PPR_DEFAULTS, ...opts };
  const top = hits.slice(0, seeds).filter((h) => h.score > 0);
  if (!top.length) return [...hits];
  const adj = adjacency(db);
  const total = top.reduce((a, h) => a + h.score, 0);
  const p = new Map(top.map((h) => [h.id, h.score / total]));
  let rank = new Map(p);
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const [id, w] of p) next.set(id, alpha * w);
    for (const [u, r] of rank) {
      const out = adj.get(u);
      if (!out?.length) {
        // Dangling: return its mass to the seeds.
        for (const [id, w] of p) next.set(id, (next.get(id) ?? 0) + (1 - alpha) * r * w);
        continue;
      }
      const share = ((1 - alpha) * r) / out.length;
      for (const v of out) next.set(v, (next.get(v) ?? 0) + share);
    }
    rank = next;
  }
  // Specificity: damp hubs.
  const specific = new Map<string, number>();
  for (const [id, r] of rank) specific.set(id, r / Math.max(1, adj.get(id)?.length ?? 0));
  const maxS = Math.max(...hits.map((h) => h.score), 1e-12);
  const maxP = Math.max(...specific.values(), 1e-12);
  const searchScore = new Map(hits.map((h) => [h.id, h.score / maxS]));
  const candidates = new Set([
    ...hits.map((h) => h.id),
    ...[...specific]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([id]) => id),
  ]);
  return [...candidates]
    .map((id) => ({
      id,
      score: mix * (searchScore.get(id) ?? 0) + (1 - mix) * ((specific.get(id) ?? 0) / maxP),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};
