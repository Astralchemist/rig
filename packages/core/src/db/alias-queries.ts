import type { SqliteAdapter } from './adapter.ts';

export interface AliasRow {
  node_id: string;
  alias: string;
  provenance: string;
  rationale: string | null;
  created_at: number;
}

export const addAlias = (
  db: SqliteAdapter,
  args: { nodeId: string; alias: string; provenance: string; rationale?: string },
): boolean => {
  const node = db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(args.nodeId);
  if (!node) return false;
  // INSERT OR IGNORE for idempotent re-adds — same (node_id, alias) is a no-op.
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO aliases (node_id, alias, provenance, rationale, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(args.nodeId, args.alias, args.provenance, args.rationale ?? null, Date.now());
  return res.changes > 0;
};

export const removeAlias = (db: SqliteAdapter, nodeId: string, alias: string): boolean => {
  const res = db
    .prepare(`DELETE FROM aliases WHERE node_id = ? AND alias = ?`)
    .run(nodeId, alias);
  return res.changes > 0;
};

export const listAliases = (db: SqliteAdapter, nodeId: string): AliasRow[] => {
  return db
    .prepare(
      `SELECT node_id, alias, provenance, rationale, created_at FROM aliases WHERE node_id = ? ORDER BY created_at`,
    )
    .all(nodeId) as AliasRow[];
};

// Resolve any alias to the set of canonical node_ids. Used by search to fold
// alias hits into the result set.
export const resolveAlias = (db: SqliteAdapter, alias: string): string[] => {
  const rows = db
    .prepare(`SELECT node_id FROM aliases WHERE alias = ?`)
    .all(alias) as { node_id: string }[];
  return rows.map((r) => r.node_id);
};
