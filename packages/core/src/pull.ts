import { decayedActivationScores } from './db/activation-queries.ts';
import type { SqliteAdapter } from './db/adapter.ts';
import { getEmbeddingsMap } from './db/embed-queries.ts';
import { getHubFlags } from './db/node-queries.ts';

export interface PullComponents {
  structural: number;
  semantic: number;
  recency: number;
  hub: number;
}

export interface PullResult {
  nodeId: string;
  score: number;
  components: PullComponents;
}

export interface PullWeights {
  structural: number;
  semantic: number;
  recency: number;
}

export const DEFAULT_WEIGHTS: PullWeights = {
  structural: 0.5,
  semantic: 0.35,
  recency: 0.15,
};

export interface PullContext {
  db: SqliteAdapter;
  now?: number;
  maxHops?: number;
  // D2: additive boost applied to a candidate's score when it is a hub. The
  // weighted (structural/semantic/recency) sum stays in [0,1]; the boost is
  // added post-weighting and then clamped, so the term is comparable to other
  // sub-component contributions without re-balancing weights. Default 0 keeps
  // legacy callers (hub-drill, internal traversal) unbiased. Rig.getMagneticPull
  // defaults to 0.3 so light-tier rig_pull surfaces hubs first.
  hubBias?: number;
}

export function computeMagneticPull(
  anchorId: string,
  candidateIds: readonly string[],
  ctx: PullContext,
  weights: PullWeights = DEFAULT_WEIGHTS,
): PullResult[] {
  const maxHops = ctx.maxHops ?? 4;
  const now = ctx.now ?? Date.now();

  const distances = bfsDistances(ctx.db, anchorId, maxHops);
  const vectors = getEmbeddingsMap(ctx.db, [anchorId, ...candidateIds]);
  const anchorVec = vectors.get(anchorId) ?? null;
  const recencies = decayedActivationScores(ctx.db, now);
  const hubBias = ctx.hubBias ?? 0;
  // Always compute hub membership so the `hub` component reflects the node's
  // structural status, not whether the caller asked for a boost. Only the
  // score uses hubBias as a multiplier.
  const hubs = getHubFlags(ctx.db, candidateIds);

  const results: PullResult[] = candidateIds.map((id) => {
    const d = distances.get(id);
    const structural = d === undefined ? 0 : 1 / (1 + d);

    let semantic = 0;
    if (anchorVec) {
      const v = vectors.get(id);
      if (v && v.length === anchorVec.length) semantic = clamp01((cosine(anchorVec, v) + 1) / 2);
    }

    const recency = recencies.get(id) ?? 0;
    const hub = hubs.has(id) ? 1 : 0;

    const score = clamp01(
      weights.structural * structural +
        weights.semantic * semantic +
        weights.recency * recency +
        hub * hubBias,
    );
    return { nodeId: id, score, components: { structural, semantic, recency, hub } };
  });

  return results.toSorted((a, b) => b.score - a.score);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const cosine = (a: Float32Array, b: Float32Array): number => {
  // Assumes L2-normalized vectors (so a·b is already the cosine).
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
};

const bfsDistances = (
  db: SqliteAdapter,
  anchorId: string,
  maxHops: number,
): Map<string, number> => {
  const dist = new Map<string, number>([[anchorId, 0]]);
  let frontier = [anchorId];
  for (let h = 1; h <= maxHops; h++) {
    if (frontier.length === 0) break;
    const ph = frontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT src, dst FROM edges WHERE src IN (${ph}) OR dst IN (${ph})`,
      )
      .all(...frontier, ...frontier) as { src: string; dst: string }[];
    const next: string[] = [];
    for (const r of rows) {
      for (const id of [r.src, r.dst]) {
        if (!dist.has(id)) {
          dist.set(id, h);
          next.push(id);
        }
      }
    }
    frontier = next;
  }
  return dist;
};
