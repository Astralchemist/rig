import type { SqliteAdapter } from './adapter.ts';

export type WaypointKind =
  | 'decision'
  | 'observation'
  | 'constraint'
  | 'open-question'
  | 'principle';

export interface WaypointRow {
  id: string;
  ts: number;
  session_id: string;
  kind: WaypointKind;
  title: string;
  summary: string;
  analogy: string | null;
  constellation_refs: readonly string[];
  predecessors: readonly string[];
  key_terms: readonly string[];
  compactable: boolean;
}

interface RawNode {
  id: string;
  name: string;
  data: string;
  created_at: number;
}

interface RawData {
  session_id?: string;
  type?: WaypointKind;
  summary?: string;
  analogy?: string;
  constellation_refs?: string[];
  predecessors?: string[];
  key_terms?: string[];
  compactable?: boolean;
}

const parse = (r: RawNode): WaypointRow => {
  const d = JSON.parse(r.data) as RawData;
  return {
    id: r.id,
    ts: r.created_at,
    session_id: d.session_id ?? '',
    kind: d.type ?? 'observation',
    title: r.name,
    summary: d.summary ?? '',
    analogy: d.analogy ?? null,
    constellation_refs: d.constellation_refs ?? [],
    predecessors: d.predecessors ?? [],
    key_terms: d.key_terms ?? [],
    compactable: d.compactable === true,
  };
};

export interface ListWaypointsOpts {
  sessionId?: string;
  kind?: WaypointKind;
  limit?: number;
}

// Return waypoints ordered newest-first. `sessionId` filters to a single
// session; `kind` filters to a single waypoint type. Default limit is 50.
export const listWaypoints = (db: SqliteAdapter, opts: ListWaypointsOpts = {}): WaypointRow[] => {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [];
  const filters: string[] = [`type = 'conversation-waypoint'`];
  if (opts.sessionId) {
    filters.push(`json_extract(data, '$.session_id') = ?`);
    params.push(opts.sessionId);
  }
  if (opts.kind) {
    filters.push(`json_extract(data, '$.type') = ?`);
    params.push(opts.kind);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT id, name, data, created_at FROM nodes
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params) as RawNode[];
  return rows.map(parse);
};

// Walk predecessor chain starting at `waypointId`. Follows waypoint_succeeds
// edges (waypoint → predecessor) up to `maxDepth` hops. Returns a list from
// the seed back through history; the seed itself is index 0.
export const getWaypointChain = (
  db: SqliteAdapter,
  waypointId: string,
  maxDepth = 10,
): WaypointRow[] => {
  const seen = new Set<string>([waypointId]);
  const chain: WaypointRow[] = [];
  const fetchOne = db.prepare(
    `SELECT id, name, data, created_at FROM nodes WHERE id = ? AND type = 'conversation-waypoint'`,
  );
  const fetchPred = db.prepare(
    `SELECT dst FROM edges WHERE src = ? AND kind = 'waypoint_succeeds'`,
  );
  let current: string | null = waypointId;
  for (let depth = 0; depth <= maxDepth && current; depth++) {
    const row = fetchOne.get(current) as RawNode | null;
    if (!row) break;
    chain.push(parse(row));
    const preds = fetchPred.all(current) as { dst: string }[];
    // Single linear chain — pick the first predecessor not yet seen.
    let next: string | null = null;
    for (const p of preds) {
      if (!seen.has(p.dst)) {
        next = p.dst;
        seen.add(p.dst);
        break;
      }
    }
    current = next;
  }
  return chain;
};

// Upsert the per-session metadata row; called every time a waypoint lands so
// `started_at` is set once and `last_seen` always reflects the newest activity.
export const touchSession = (db: SqliteAdapter, sessionId: string): void => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, started_at, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(sessionId, now, now);
};
