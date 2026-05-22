import type { SqliteAdapter } from './adapter.ts';

export interface FileRow {
  path: string;
  language?: string;
  node_count: number;
  last_indexed_ts?: number;
}

export const getFiles = (db: SqliteAdapter, filter?: string): FileRow[] => {
  const rows = filter
    ? (db
        .prepare(`SELECT path, mtime FROM files WHERE path LIKE ? ORDER BY path`)
        .all(`%${filter}%`) as { path: string; mtime: number }[])
    : (db.prepare(`SELECT path, mtime FROM files ORDER BY path`).all() as {
        path: string;
        mtime: number;
      }[]);

  const ncRows = db
    .prepare(
      `SELECT json_extract(data, '$.filePath') as fp, COUNT(*) as n FROM nodes GROUP BY fp`,
    )
    .all() as { fp: string | null; n: number }[];
  const countByPath = new Map<string, number>();
  for (const r of ncRows) if (r.fp) countByPath.set(r.fp, r.n);

  return rows.map((r) => ({
    path: r.path,
    node_count: countByPath.get(r.path) ?? 0,
    last_indexed_ts: r.mtime,
  }));
};
