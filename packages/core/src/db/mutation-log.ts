// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';

export type MutationKind =
  | 'add_node'
  | 'propose_edge'
  | 'accept_edge'
  | 'reject_edge'
  | 'annotate'
  | 'cluster'
  | 'focus'
  | 'selection'
  | 'drop_waypoint'
  | 'add_alias'
  | 'promote_hub'
  | 'undo';

export interface MutationRow {
  id: number;
  ts: number;
  session_id: string;
  kind: MutationKind;
  payload: unknown;
  actor: string;
}

interface RawRow {
  id: number;
  ts: number;
  session_id: string;
  kind: MutationKind;
  payload: string;
  actor: string;
}

const parse = (r: RawRow): MutationRow => ({
  id: r.id,
  ts: r.ts,
  session_id: r.session_id,
  kind: r.kind,
  payload: JSON.parse(r.payload) as unknown,
  actor: r.actor,
});

export interface RecordInput {
  sessionId: string;
  kind: MutationKind;
  payload: unknown;
  actor: string;
}

export const recordMutation = (db: SqliteAdapter, m: RecordInput): number => {
  const r = db
    .prepare(
      `INSERT INTO mutation_log (ts, session_id, kind, payload, actor) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(Date.now(), m.sessionId, m.kind, JSON.stringify(m.payload), m.actor);
  return Number(r.lastInsertRowid);
};

export const lastUndoableMutation = (
  db: SqliteAdapter,
  sessionId: string,
): MutationRow | null => {
  const row = db
    .prepare(
      `SELECT id, ts, session_id, kind, payload, actor FROM mutation_log
       WHERE session_id = ?
       AND kind NOT IN ('undo', 'focus', 'selection')
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(sessionId) as RawRow | null;
  return row ? parse(row) : null;
};

export const listMutationsSince = (
  db: SqliteAdapter,
  sinceTs: number,
  sessionId?: string,
): MutationRow[] => {
  const rows = sessionId
    ? (db
        .prepare(
          `SELECT id, ts, session_id, kind, payload, actor FROM mutation_log
           WHERE ts > ? AND session_id = ?
           ORDER BY ts ASC LIMIT 200`,
        )
        .all(sinceTs, sessionId) as RawRow[])
    : (db
        .prepare(
          `SELECT id, ts, session_id, kind, payload, actor FROM mutation_log
           WHERE ts > ?
           ORDER BY ts ASC LIMIT 200`,
        )
        .all(sinceTs) as RawRow[]);
  return rows.map(parse);
};
