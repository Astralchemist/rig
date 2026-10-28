// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';

export type WaypointKind =
  | 'decision'
  | 'observation'
  | 'constraint'
  | 'open-question'
  | 'principle';

// B2 — payloads carried inline on a waypoint. Each shape is a self-contained
// chunk re-renderable in a UI / re-injectable into a future prompt. The union
// is open-ended through `Record<string, unknown>` so future payload types ship
// without core changes; the contract layer enforces strictness at MCP boundary.
export type WaypointPayload =
  | { type: 'text-summary'; content: string }
  | { type: 'mermaid-diagram'; content: string }
  | { type: 'code-snippet'; lang: string; content: string }
  | { type: 'doc-fragment'; content: string }
  | { type: 'image-ref'; path: string; alt?: string | undefined }
  | { type: 'dataset-pointer'; query: string };

export interface WaypointRow {
  id: string;
  ts: number;
  session_id: string;
  kind: WaypointKind;
  title: string;
  summary: string;
  analogy: string | null;
  constellation_refs: string[];
  predecessors: string[];
  key_terms: string[];
  compactable: boolean;
  payloads: WaypointPayload[];
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
  payloads?: WaypointPayload[];
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
    payloads: d.payloads ?? [],
  };
};

export interface ListWaypointsOpts {
  // Pass 'last' to resolve to the most-recently-active session via sessions.last_seen.
  sessionId?: string;
  kind?: WaypointKind;
  limit?: number;
}

// Returns the id of the most-recently-active session, or null if no waypoints
// have ever been dropped. Drives B4 (cross-session retrieval) so a fresh agent
// session can call rig_waypoints session_id=last and pick up where the last
// one ended.
export const getLastSessionId = (db: SqliteAdapter): string | null => {
  const row = db
    .prepare(`SELECT id FROM sessions ORDER BY last_seen DESC LIMIT 1`)
    .get() as { id: string } | null;
  return row ? row.id : null;
};

// Return waypoints ordered newest-first. `sessionId` filters to a single
// session; `kind` filters to a single waypoint type. Pass sessionId='last' to
// auto-resolve to the most-recently-active session. Default limit is 50.
export const listWaypoints = (db: SqliteAdapter, opts: ListWaypointsOpts = {}): WaypointRow[] => {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [];
  const filters: string[] = [`type = 'conversation-waypoint'`];
  const requestedSession =
    opts.sessionId === 'last' ? getLastSessionId(db) : (opts.sessionId ?? null);
  if (opts.sessionId === 'last' && requestedSession === null) {
    // No prior session — return empty rather than fall back to "all sessions".
    return [];
  }
  if (requestedSession !== null) {
    filters.push(`json_extract(data, '$.session_id') = ?`);
    params.push(requestedSession);
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
