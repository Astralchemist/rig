import type { SqliteAdapter } from './adapter.ts';

const countOf = (db: SqliteAdapter, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
};

export interface DbCounts {
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_activation_ts: number | null;
}

export const readCounts = (db: SqliteAdapter): DbCounts => {
  const last = db
    .prepare('SELECT MAX(ts) AS ts FROM activations')
    .get() as { ts: number | null } | null;
  return {
    nodes: countOf(db, 'nodes'),
    edges_structural: countOf(db, 'edges'),
    edges_semantic: countOf(db, 'edges_semantic'),
    files: countOf(db, 'files'),
    last_activation_ts: last?.ts ?? null,
  };
};
