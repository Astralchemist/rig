// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';
import type { Node } from '../extract/upstream-types.ts';

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
    isExported: data.isExported ?? false,
    isAsync: data.isAsync ?? false,
    isStatic: data.isStatic ?? false,
  };
};

export const getNode = (db: SqliteAdapter, id: string): Node | null => {
  const row = db
    .prepare('SELECT id, type, name, data FROM nodes WHERE id = ?')
    .get(id) as NodeRow | null;
  return row ? rowToNode(row) : null;
};

export const getCallers = (db: SqliteAdapter, id: string): Node[] => {
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.name, n.data FROM edges e
       JOIN nodes n ON e.src = n.id
       WHERE e.dst = ? AND e.kind = 'calls'`,
    )
    .all(id) as NodeRow[];
  return rows.map(rowToNode);
};

export const getCallees = (db: SqliteAdapter, id: string): Node[] => {
  const rows = db
    .prepare(
      `SELECT n.id, n.type, n.name, n.data FROM edges e
       JOIN nodes n ON e.dst = n.id
       WHERE e.src = ? AND e.kind = 'calls'`,
    )
    .all(id) as NodeRow[];
  return rows.map(rowToNode);
};

export const getImpactRadius = (db: SqliteAdapter, id: string, depth = 3): Node[] => {
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(id, hops) AS (
         SELECT ?, 0
         UNION
         SELECT e.src, r.hops + 1 FROM edges e
         JOIN reach r ON e.dst = r.id
         WHERE r.hops < ?
       )
       SELECT n.id, n.type, n.name, n.data FROM nodes n
       JOIN reach r ON n.id = r.id
       WHERE r.hops > 0`,
    )
    .all(id, depth) as NodeRow[];
  return rows.map(rowToNode);
};
