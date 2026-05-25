// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';
import { computeMagneticPull } from '../pull.ts';

export interface DrillResult {
  id: string;
  name: string;
  type: string;
  depth: number;
  pull_score: number;
}

// Walk outward from a hub via structural edges (contains > references > calls),
// rank descendants by magnetic pull relative to the hub, optionally filter by
// name substring. Used by rig_drill.
export const drillFromHub = (
  db: SqliteAdapter,
  hubId: string,
  opts: { query?: string; maxDepth?: number; limit?: number } = {},
): DrillResult[] => {
  const maxDepth = opts.maxDepth ?? 3;
  const limit = opts.limit ?? 50;
  const hub = db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(hubId);
  if (!hub) return [];

  const visited = new Map<string, number>(); // id -> depth
  let frontier = new Set<string>([hubId]);
  visited.set(hubId, 0);
  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
    const placeholders = Array.from(frontier).map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT e.dst AS id FROM edges e
         WHERE e.src IN (${placeholders})
           AND e.kind IN ('contains', 'references', 'calls', 'imports')`,
      )
      .all(...Array.from(frontier)) as { id: string }[];
    const next = new Set<string>();
    for (const r of rows) {
      if (!visited.has(r.id)) {
        visited.set(r.id, depth);
        next.add(r.id);
      }
    }
    frontier = next;
  }
  visited.delete(hubId);

  if (visited.size === 0) return [];

  // Rank descendants by magnetic pull from the hub.
  const candidates = Array.from(visited.keys());
  const pulled = computeMagneticPull(hubId, candidates, { db });

  const nameRows = db
    .prepare(
      `SELECT id, name, type FROM nodes WHERE id IN (${candidates.map(() => '?').join(',')})`,
    )
    .all(...candidates) as { id: string; name: string; type: string }[];
  const meta = new Map(nameRows.map((r) => [r.id, r]));

  const q = opts.query?.toLowerCase();
  const out: DrillResult[] = pulled
    .map((p) => {
      const m = meta.get(p.nodeId);
      if (!m) return null;
      if (q && !m.name.toLowerCase().includes(q)) return null;
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        depth: visited.get(m.id) ?? -1,
        pull_score: p.score,
      };
    })
    .filter((x): x is DrillResult => x !== null)
    .slice(0, limit);
  return out;
};
