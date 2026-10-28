// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';

// meta (v13): key/value facts about the graph itself.
//   last_index_ts  when `rig index` last brought the graph up to date (ms)
//   last_sync_ts   when `rig sync` or the file watcher last did (ms)
// Both are written by the update pipeline (update.ts) once a run's graph
// changes are in, whether or not any file had changed.
export const META_LAST_INDEX_TS = 'last_index_ts';
export const META_LAST_SYNC_TS = 'last_sync_ts';

export const getMeta = (db: SqliteAdapter, key: string): string | null => {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as {
    value: string;
  } | null;
  return row ? row.value : null;
};

export const setMeta = (db: SqliteAdapter, key: string, value: string): void => {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
};

// A timestamp key, or null when it was never written.
export const getMetaTs = (db: SqliteAdapter, key: string): number | null => {
  const n = Number(getMeta(db, key) ?? Number.NaN);
  return Number.isFinite(n) ? n : null;
};
