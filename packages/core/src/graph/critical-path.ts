import type { SqliteAdapter } from '../db/adapter.ts';

export interface CriticalStep {
  id: string;
  name: string;
  type: string;
  hubness: number;
  activation_count: number;
  step_weight: number;
}

interface NodeRow {
  id: string;
  name: string;
  type: string;
  hubness: number;
}

interface OutboundRow {
  dst: string;
  name: string;
  type: string;
  hubness: number;
  activation_count: number;
  kind: string;
}

const STEP_BUDGET = 16;
const W_HUBNESS = 0.5;
const W_ACTIVATION = 0.3;
const W_KIND = 0.2; // contains > references > calls > imports

const KIND_WEIGHT: Record<string, number> = {
  contains: 1.0,
  references: 0.75,
  calls: 0.6,
  imports: 0.5,
  tests: 0.4,
  extends: 0.4,
  implements: 0.35,
};

// Walk outward from a root anchor by the highest-scoring outbound edge at each
// step. Score = hubness(dst) + decayed-activation-density(dst) + edge-kind
// affinity. Stops at a leaf or at STEP_BUDGET hops, whichever comes first.
//
// Conceptually: "if I were navigating this codebase to find the spine, which
// chain of anchors would I walk?" Useful as a one-shot architecture tour for
// any subsystem.
export const computeCriticalPath = (
  db: SqliteAdapter,
  rootId: string,
  maxSteps = STEP_BUDGET,
): CriticalStep[] => {
  const root = db
    .prepare(`SELECT id, name, type, hubness FROM nodes WHERE id = ?`)
    .get(rootId) as NodeRow | null;
  if (!root) return [];

  const visited = new Set<string>([rootId]);
  const out: CriticalStep[] = [
    {
      id: root.id,
      name: root.name,
      type: root.type,
      hubness: root.hubness,
      activation_count: 0,
      step_weight: 0,
    },
  ];

  let current = root.id;
  for (let step = 1; step < maxSteps; step++) {
    // For each outbound edge from `current`, score the candidate destination.
    const rows = db
      .prepare(
        `SELECT e.dst, n.name, n.type, n.hubness, e.kind,
                COALESCE((SELECT COUNT(*) FROM activations a WHERE a.node_id = e.dst), 0) AS activation_count
         FROM edges e
         JOIN nodes n ON n.id = e.dst
         WHERE e.src = ?
         ORDER BY n.hubness DESC LIMIT 32`,
      )
      .all(current) as OutboundRow[];
    if (rows.length === 0) break;

    // Normalize activation counts in this candidate set so it's comparable to
    // the [0, 1] hubness scale.
    const maxAct = Math.max(1, ...rows.map((r) => r.activation_count));
    let best: { row: OutboundRow; score: number } | null = null;
    for (const r of rows) {
      if (visited.has(r.dst)) continue;
      const score =
        W_HUBNESS * r.hubness +
        W_ACTIVATION * (r.activation_count / maxAct) +
        W_KIND * (KIND_WEIGHT[r.kind] ?? 0.3);
      if (!best || score > best.score) best = { row: r, score };
    }
    if (!best) break;

    visited.add(best.row.dst);
    out.push({
      id: best.row.dst,
      name: best.row.name,
      type: best.row.type,
      hubness: best.row.hubness,
      activation_count: best.row.activation_count,
      step_weight: best.score,
    });
    current = best.row.dst;
  }

  return out;
};
