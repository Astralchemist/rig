import type { Node } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

interface NodeRow {
  id: string;
  type: string;
  name: string;
  data: string;
}

const rowToNode = (row: NodeRow): Node => {
  const data = JSON.parse(row.data) as Partial<Node>;
  return {
    id: row.id,
    kind: row.type as Node['kind'],
    name: row.name,
    qualifiedName: data.qualifiedName ?? row.name,
    filePath: data.filePath ?? '',
    language: data.language ?? 'unknown',
    startLine: data.startLine ?? 0,
    endLine: data.endLine ?? 0,
    startColumn: data.startColumn ?? 0,
    endColumn: data.endColumn ?? 0,
    updatedAt: data.updatedAt ?? 0,
    ...(data.signature !== undefined ? { signature: data.signature } : {}),
    ...(data.docstring !== undefined ? { docstring: data.docstring } : {}),
  };
};

export interface SearchOptions {
  kind?: string | undefined;
  limit?: number | undefined;
}

// Each user-supplied token becomes a quoted prefix-match — so the user can
// type "authStor" and hit "authStore", and special FTS5 syntax in their query
// is treated literally.
const toFtsQuery = (raw: string): string =>
  raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');

export const searchNodes = (
  db: SqliteAdapter,
  query: string,
  opts: SearchOptions = {},
): Node[] => {
  const limit = opts.limit ?? 20;
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  let sql =
    `SELECT n.id, n.type, n.name, n.data FROM nodes_fts
     JOIN nodes n ON n.id = nodes_fts.node_id
     WHERE nodes_fts MATCH ?`;
  const params: unknown[] = [ftsQuery];
  if (opts.kind) {
    sql += ` AND n.type = ?`;
    params.push(opts.kind);
  }
  sql += ` ORDER BY bm25(nodes_fts) LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as NodeRow[]).map(rowToNode);
};
