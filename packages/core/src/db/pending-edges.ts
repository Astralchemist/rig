// SPDX-License-Identifier: Apache-2.0
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
  source_urls: string[];
}

export interface ProposeInput {
  src: string;
  dst: string;
  kind?: string;
  weight?: number;
  provenance: string;
  rationale: string;
  sessionId: string;
  // E1 — URLs the agent cited while validating the proposal (browser/web tools).
  sourceUrls?: readonly string[];
}

interface RawPendingRow {
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
  source_urls: string | null;
}

// source_urls columns (pending_edges, edges_semantic) hold a JSON array or NULL.
export const parseSourceUrls = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    // legacy / corrupt row — surface as empty, do not throw
  }
  return [];
};

const parsePending = (r: RawPendingRow): PendingEdgeRow => ({
  ...r,
  source_urls: parseSourceUrls(r.source_urls),
});

export const proposeEdge = (db: SqliteAdapter, input: ProposeInput): number => {
  const urls = input.sourceUrls && input.sourceUrls.length ? JSON.stringify(input.sourceUrls) : null;
  const r = db
    .prepare(
      `INSERT INTO pending_edges (src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
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
      urls,
    );
  return Number(r.lastInsertRowid);
};

export const getPendingEdge = (
  db: SqliteAdapter,
  pendingId: number,
): PendingEdgeRow | null => {
  const row = db.prepare(`SELECT * FROM pending_edges WHERE id = ?`).get(pendingId) as
    | RawPendingRow
    | null;
  return row ? parsePending(row) : null;
};

export const listPendingEdges = (db: SqliteAdapter): PendingEdgeRow[] => {
  const rows = db
    .prepare(`SELECT * FROM pending_edges WHERE status = 'pending' ORDER BY id`)
    .all() as RawPendingRow[];
  return rows.map(parsePending);
};

// Promotes a pending edge into edges_semantic, kind and evidence URLs
// included. Returns the promoted row or null if the pending id is missing or
// not in 'pending' state.
export const acceptPending = (
  db: SqliteAdapter,
  pendingId: number,
): PendingEdgeRow | null => {
  const row = getPendingEdge(db, pendingId);
  if (!row || row.status !== 'pending') return null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO edges_semantic (src, dst, weight, provenance, rationale, created_at, kind, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.src,
      row.dst,
      row.weight,
      row.provenance,
      row.rationale,
      Date.now(),
      row.kind,
      row.source_urls.length ? JSON.stringify(row.source_urls) : null,
    );
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
