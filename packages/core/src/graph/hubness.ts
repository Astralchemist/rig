import { decayedActivationScores } from '../db/activation-queries.ts';
import type { SqliteAdapter } from '../db/adapter.ts';

// Phase 3.5 A1 + C1 — fanout structure × explicit promote × heat (recent
// activation decay). Betweenness centrality is still deferred.
// Formula: hubness = w_fanout * fanout_normalized
//                  + w_heat   * heat_normalized
//                  + w_explicit * is_marked.
const W_FANOUT = 0.55;
const W_HEAT = 0.15;
const W_EXPLICIT = 0.3;
const TOP_PERCENT = 0.05;

interface FanoutRow {
  id: string;
  type: string;
  hub_explicit: number;
  fanout: number;
}

// Full recompute over all nodes. Cheap at <5k nodes (~20ms); above that, sync
// callers should prefer `recomputeHubnessForFiles(changedPaths)` which limits
// the work to affected anchor types.
export const recomputeHubness = (db: SqliteAdapter, scopeTypes?: Set<string>): void => {
  // Outgoing `contains` edges as the fanout signal — a node that "contains" many
  // children is structurally a hub (files, modules, classes with methods, etc.).
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.hub_explicit,
              COALESCE((SELECT COUNT(*) FROM edges e WHERE e.src = n.id AND e.kind = 'contains'), 0) AS fanout
       FROM nodes n
       ${scopeTypes && scopeTypes.size > 0 ? `WHERE n.type IN (${Array.from(scopeTypes).map(() => '?').join(',')})` : ''}`,
    )
    .all(...(scopeTypes ? Array.from(scopeTypes) : [])) as FanoutRow[];

  // Normalize fanout AND heat per anchor type so files don't dominate methods
  // on either axis. heatScores comes from C1's decayed-activation aggregate
  // (in [0,1] per node already); we further normalize within the type so the
  // hottest node of each type maps to 1.0.
  const heatScores = decayedActivationScores(db);
  const maxFanoutByType = new Map<string, number>();
  const maxHeatByType = new Map<string, number>();
  for (const r of rows) {
    const f = maxFanoutByType.get(r.type) ?? 0;
    if (r.fanout > f) maxFanoutByType.set(r.type, r.fanout);
    const h = heatScores.get(r.id) ?? 0;
    const mh = maxHeatByType.get(r.type) ?? 0;
    if (h > mh) maxHeatByType.set(r.type, h);
  }

  const scored = rows.map((r) => {
    const maxF = maxFanoutByType.get(r.type) ?? 1;
    const maxH = maxHeatByType.get(r.type) ?? 0;
    const fanoutNorm = maxF > 0 ? r.fanout / maxF : 0;
    const rawHeat = heatScores.get(r.id) ?? 0;
    const heatNorm = maxH > 0 ? rawHeat / maxH : 0;
    const hubness =
      W_FANOUT * fanoutNorm + W_HEAT * heatNorm + W_EXPLICIT * (r.hub_explicit ? 1 : 0);
    return { id: r.id, type: r.type, hubness, explicit: r.hub_explicit };
  });

  // Pick top 5% by hubness per type as is_hub. Any explicit-marked node is a hub.
  const byType = new Map<string, typeof scored>();
  for (const s of scored) {
    const arr = byType.get(s.type) ?? [];
    arr.push(s);
    byType.set(s.type, arr);
  }
  const hubIds = new Set<string>();
  for (const [, arr] of byType) {
    arr.sort((a, b) => b.hubness - a.hubness);
    const k = Math.max(1, Math.ceil(arr.length * TOP_PERCENT));
    for (let i = 0; i < arr.length; i++) {
      if (i < k || arr[i]!.explicit) hubIds.add(arr[i]!.id);
    }
  }

  db.transaction(() => {
    const upd = db.prepare(`UPDATE nodes SET hubness = ?, is_hub = ? WHERE id = ?`);
    for (const s of scored) upd.run(s.hubness, hubIds.has(s.id) ? 1 : 0, s.id);
  })();
};

// Incremental variant — used by sync. Restricts the recompute to anchor types
// found in the changed file set; the global top-5% threshold is re-picked
// within those types only. At 50k nodes this drops a full ~200ms recompute to
// ~5–20ms in the common case (one file → one or two affected types).
export const recomputeHubnessForFiles = (
  db: SqliteAdapter,
  changedPaths: readonly string[],
): void => {
  if (changedPaths.length === 0) return;
  const placeholders = changedPaths.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT type FROM nodes WHERE json_extract(data, '$.filePath') IN (${placeholders})`,
    )
    .all(...changedPaths) as { type: string }[];
  const types = new Set(rows.map((r) => r.type));
  if (types.size === 0) {
    // No anchor types touched (likely all-deleted files) — fall back to full
    // recompute so any orphaned hub flags clean up.
    recomputeHubness(db);
    return;
  }
  recomputeHubness(db, types);
};

export interface HubRef {
  id: string;
  name: string;
  type: string;
  hubness: number;
  explicit: boolean;
}

export const getTopHubs = (db: SqliteAdapter, opts: { scope?: string; limit?: number } = {}): HubRef[] => {
  const limit = opts.limit ?? 20;
  const params: (string | number)[] = [];
  let where = `WHERE is_hub = 1`;
  if (opts.scope) {
    where += ` AND type = ?`;
    params.push(opts.scope);
  }
  params.push(limit);
  const rows = db
    .prepare(`SELECT id, name, type, hubness, hub_explicit FROM nodes ${where} ORDER BY hubness DESC LIMIT ?`)
    .all(...params) as { id: string; name: string; type: string; hubness: number; hub_explicit: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    hubness: r.hubness,
    explicit: r.hub_explicit === 1,
  }));
};

export const promoteHub = (db: SqliteAdapter, nodeId: string): boolean => {
  const node = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(nodeId);
  if (!node) return false;
  db.prepare(`UPDATE nodes SET hub_explicit = 1, is_hub = 1 WHERE id = ?`).run(nodeId);
  return true;
};

// The hubs a node belongs to. Walks BOTH directions of the structural graph
// (containers are inbound via `contains`; outbound for calls/imports). Stops at
// the first depth that yields any hub — "nearest hub" semantics.
export const hubsOf = (db: SqliteAdapter, nodeId: string, maxDepth = 3): HubRef[] => {
  const seen = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  const found: HubRef[] = [];
  for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
    const placeholders = Array.from(frontier).map(() => '?').join(',');
    const params = [...Array.from(frontier), ...Array.from(frontier)];
    const rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.name, n.type, n.hubness, n.hub_explicit FROM nodes n
         WHERE n.is_hub = 1
           AND (n.id IN (SELECT dst FROM edges WHERE src IN (${placeholders}))
             OR n.id IN (SELECT src FROM edges WHERE dst IN (${placeholders})))`,
      )
      .all(...params) as { id: string; name: string; type: string; hubness: number; hub_explicit: number }[];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        found.push({
          id: r.id,
          name: r.name,
          type: r.type,
          hubness: r.hubness,
          explicit: r.hub_explicit === 1,
        });
      }
    }
    if (found.length > 0) break;
    const nextRows = db
      .prepare(
        `SELECT DISTINCT dst AS id FROM edges WHERE src IN (${placeholders})
         UNION SELECT DISTINCT src AS id FROM edges WHERE dst IN (${placeholders})`,
      )
      .all(...params) as { id: string }[];
    const next = new Set<string>();
    for (const r of nextRows) if (!seen.has(r.id)) next.add(r.id);
    for (const id of next) seen.add(id);
    frontier = next;
  }
  return found.sort((a, b) => b.hubness - a.hubness);
};
