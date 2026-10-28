// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';
import { META_LAST_INDEX_TS, META_LAST_SYNC_TS, getMetaTs } from './meta.ts';

const countOf = (db: SqliteAdapter, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
};

export interface DbCounts {
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  orphans: number;
  last_activation_ts: number | null;
  // When `rig index`, and `rig sync` or the watcher, last completed (meta).
  last_index_ts: number | null;
  last_sync_ts: number | null;
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
    orphans: countOf(db, 'orphaned_memory'),
    last_activation_ts: last?.ts ?? null,
    last_index_ts: getMetaTs(db, META_LAST_INDEX_TS),
    last_sync_ts: getMetaTs(db, META_LAST_SYNC_TS),
  };
};
