// SPDX-License-Identifier: Apache-2.0
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

  // FTS5 hits over nodes_fts (name/qualified_name) UNIONed with aliases_fts.
  // GROUP BY id keeps one row per canonical anchor; MIN(rank) preserves the
  // best match across both sources. bm25 returns negative-ish values where
  // lower is better — MIN gives us the strongest hit.
  const kindFilter = opts.kind ? `AND n.type = ?` : '';
  const sql = `
    SELECT id, type, name, data, MIN(rank) AS rank FROM (
      SELECT n.id, n.type, n.name, n.data, bm25(nodes_fts) AS rank
      FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
      WHERE nodes_fts MATCH ? ${kindFilter}
      UNION ALL
      SELECT n.id, n.type, n.name, n.data, bm25(aliases_fts) AS rank
      FROM aliases_fts JOIN nodes n ON n.id = aliases_fts.node_id
      WHERE aliases_fts MATCH ? ${kindFilter}
    )
    GROUP BY id
    ORDER BY rank
    LIMIT ?
  `;
  const params: unknown[] = [ftsQuery];
  if (opts.kind) params.push(opts.kind);
  params.push(ftsQuery);
  if (opts.kind) params.push(opts.kind);
  params.push(limit);
  return (db.prepare(sql).all(...params) as NodeRow[]).map(rowToNode);
};
