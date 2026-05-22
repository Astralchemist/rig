import type { SqliteAdapter } from './adapter.ts';

export interface PendingEdgeRow {
  id: number;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  provenance: string;
  rationale: string;
  proposed_at: number;
  session_id: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ProposeInput {
  src: string;
  dst: string;
  kind?: string;
  weight?: number;
  provenance: string;
  rationale: string;
  sessionId: string;
}

export const proposeEdge = (db: SqliteAdapter, input: ProposeInput): number => {
  const r = db
    .prepare(
      `INSERT INTO pending_edges (src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      input.src,
      input.dst,
      input.kind ?? 'related',
      input.weight ?? 0.5,
      input.provenance,
      input.rationale,
      Date.now(),
      input.sessionId,
    );
  return Number(r.lastInsertRowid);
};

export const getPendingEdge = (
  db: SqliteAdapter,
  pendingId: number,
): PendingEdgeRow | null =>
  (db.prepare(`SELECT * FROM pending_edges WHERE id = ?`).get(pendingId) ??
    null) as PendingEdgeRow | null;

export const listPendingEdges = (db: SqliteAdapter): PendingEdgeRow[] =>
  db.prepare(`SELECT * FROM pending_edges WHERE status = 'pending' ORDER BY id`).all() as PendingEdgeRow[];

// Promotes a pending edge into edges_semantic. Returns the promoted row or
// null if the pending id is missing or not in 'pending' state.
export const acceptPending = (
  db: SqliteAdapter,
  pendingId: number,
): PendingEdgeRow | null => {
  const row = getPendingEdge(db, pendingId);
  if (!row || row.status !== 'pending') return null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO edges_semantic (src, dst, weight, provenance, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.src, row.dst, row.weight, row.provenance, row.rationale, Date.now());
    db.prepare(`UPDATE pending_edges SET status = 'accepted' WHERE id = ?`).run(pendingId);
  })();
  return row;
};

export const rejectPending = (db: SqliteAdapter, pendingId: number): boolean => {
  const r = db
    .prepare(`UPDATE pending_edges SET status = 'rejected' WHERE id = ? AND status = 'pending'`)
    .run(pendingId);
  return r.changes > 0;
};

export const restorePendingToPending = (db: SqliteAdapter, pendingId: number): void => {
  db.prepare(`UPDATE pending_edges SET status = 'pending' WHERE id = ?`).run(pendingId);
};

export const removeSemanticEdge = (
  db: SqliteAdapter,
  src: string,
  dst: string,
  provenance: string,
): void => {
  db.prepare(`DELETE FROM edges_semantic WHERE src = ? AND dst = ? AND provenance = ?`).run(
    src,
    dst,
    provenance,
  );
};
