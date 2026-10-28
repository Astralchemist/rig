// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';

// rig_annotate notes. They live in their own table (v12) rather than in
// nodes.data, which extraction rewrites on every re-extract; the FK cascades
// them only when the node itself is deleted (after the update pipeline has
// snapshotted them into orphaned_memory).
export interface AnnotationRow {
  id: number;
  node_id: string;
  note: string;
  ts: number;
  actor: string;
  rationale: string | null;
}

// Returns the new annotation id, or null when the node does not exist.
export const addAnnotation = (
  db: SqliteAdapter,
  args: { nodeId: string; note: string; actor: string; rationale?: string | null; ts?: number },
): number | null => {
  const node = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(args.nodeId);
  if (!node) return null;
  const res = db
    .prepare(`INSERT INTO annotations (node_id, note, ts, actor, rationale) VALUES (?, ?, ?, ?, ?)`)
    .run(args.nodeId, args.note, args.ts ?? Date.now(), args.actor, args.rationale ?? null);
  return Number(res.lastInsertRowid);
};

export const listAnnotations = (db: SqliteAdapter, nodeId: string): AnnotationRow[] =>
  db
    .prepare(
      `SELECT id, node_id, note, ts, actor, rationale FROM annotations WHERE node_id = ? ORDER BY ts, id`,
    )
    .all(nodeId) as AnnotationRow[];
