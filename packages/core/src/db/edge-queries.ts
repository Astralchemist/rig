// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';

export interface TaggedEdge {
  src: string;
  dst: string;
  kind: string;
  weight?: number;
  table: 'structural' | 'semantic';
}

export interface NeighborsOptions {
  kind?: string | undefined;
  limit?: number | undefined;
}

export const getNeighbors = (
  db: SqliteAdapter,
  id: string,
  opts: NeighborsOptions = {},
): TaggedEdge[] => {
  const limit = opts.limit ?? 100;
  const out: TaggedEdge[] = [];

  let structSql = `SELECT src, dst, kind FROM edges WHERE (src = ? OR dst = ?)`;
  const structParams: unknown[] = [id, id];
  if (opts.kind) {
    structSql += ` AND kind = ?`;
    structParams.push(opts.kind);
  }
  structSql += ` LIMIT ?`;
  structParams.push(limit);
  const structRows = db.prepare(structSql).all(...structParams) as {
    src: string;
    dst: string;
    kind: string;
  }[];
  for (const r of structRows) {
    out.push({ src: r.src, dst: r.dst, kind: r.kind, table: 'structural' });
  }

  if (!opts.kind || opts.kind === 'related') {
    const semRows = db
      .prepare(
        `SELECT src, dst, weight FROM edges_semantic WHERE (src = ? OR dst = ?) LIMIT ?`,
      )
      .all(id, id, limit) as { src: string; dst: string; weight: number }[];
    for (const r of semRows) {
      out.push({
        src: r.src,
        dst: r.dst,
        kind: 'related',
        weight: r.weight,
        table: 'semantic',
      });
    }
  }

  return out.slice(0, limit);
};

export const countNeighborsByKind = (
  db: SqliteAdapter,
  id: string,
): Record<string, number> => {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) as n FROM edges WHERE src = ? OR dst = ? GROUP BY kind`,
    )
    .all(id, id) as { kind: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  const semRow = db
    .prepare(
      `SELECT COUNT(*) as n FROM edges_semantic WHERE src = ? OR dst = ?`,
    )
    .get(id, id) as { n: number } | null;
  if (semRow && semRow.n > 0) out.related = semRow.n;
  return out;
};
