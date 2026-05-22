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

// Phase 1.6: LIKE-based. FTS5 wiring (population + content-table mapping) is a
// follow-up; the nodes_fts virtual table exists but no triggers populate it.
export const searchNodes = (
  db: SqliteAdapter,
  query: string,
  opts: SearchOptions = {},
): Node[] => {
  const limit = opts.limit ?? 20;
  const pattern = `%${query}%`;
  const params: unknown[] = [pattern, pattern];
  let sql =
    `SELECT id, type, name, data FROM nodes WHERE (name LIKE ? OR data LIKE ?)`;
  if (opts.kind) {
    sql += ` AND type = ?`;
    params.push(opts.kind);
  }
  sql += ` ORDER BY name LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as NodeRow[]).map(rowToNode);
};
