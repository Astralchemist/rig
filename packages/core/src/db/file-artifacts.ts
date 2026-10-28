// SPDX-License-Identifier: Apache-2.0
import type { Edge, UnresolvedReference } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

// Per-file extraction artifacts (v12): the unresolved references and direct
// edges a file's last extraction produced, with node ids already rewritten to
// the ids the update kept. Structural edges are rebuilt from the artifacts of
// every file (resolve/rebuild-edges.ts), so re-extracting a subset of files can
// never drop another file's edges. Rows cascade with the files row.
//
// `payload` holds the complete extraction object as JSON and is what the
// rebuild reads back, so any field an extractor adds (a ref's language,
// imported names, alias, an edge's metadata) reaches the resolver exactly as a
// fresh extraction would deliver it, without a migration. The other columns
// are copies for querying.

// Replace a file's artifacts. The files row must exist (FK).
export const replaceFileArtifacts = (
  db: SqliteAdapter,
  path: string,
  refs: readonly UnresolvedReference[],
  edges: readonly Edge[],
): void => {
  db.prepare(`DELETE FROM file_refs WHERE path = ?`).run(path);
  db.prepare(`DELETE FROM file_edges WHERE path = ?`).run(path);
  const insRef = db.prepare(
    `INSERT INTO file_refs (path, src, target_name, kind, payload) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of refs) {
    insRef.run(path, r.fromNodeId, r.referenceName, r.referenceKind, JSON.stringify(r));
  }
  const insEdge = db.prepare(
    `INSERT INTO file_edges (path, src, dst, kind, payload) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const e of edges) insEdge.run(path, e.source, e.target, e.kind, JSON.stringify(e));
};

export interface FileArtifacts {
  refs: UnresolvedReference[];
  edges: Edge[];
}

// Load every file's artifacts, in insertion order, exactly as stored.
export const loadAllFileArtifacts = (db: SqliteAdapter): FileArtifacts => {
  const parse = <T>(rows: unknown[]): T[] =>
    (rows as { payload: string }[]).map((r) => JSON.parse(r.payload) as T);
  return {
    refs: parse<UnresolvedReference>(
      db.prepare(`SELECT payload FROM file_refs ORDER BY rowid`).all(),
    ),
    edges: parse<Edge>(db.prepare(`SELECT payload FROM file_edges ORDER BY rowid`).all()),
  };
};
