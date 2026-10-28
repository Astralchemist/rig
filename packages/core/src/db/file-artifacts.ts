// SPDX-License-Identifier: Apache-2.0
import { detectLanguage } from '../extract/grammars.ts';
import type { Edge, EdgeKind, Language, UnresolvedReference } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

// Per-file extraction artifacts (v12): the unresolved references and direct
// edges a file's last extraction produced, with node ids already rewritten to
// the ids the update kept. Structural edges are rebuilt from the artifacts of
// every file (resolve/rebuild-edges.ts), so re-extracting a subset of files can
// never drop another file's edges. Rows cascade with the files row.

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
    `INSERT INTO file_refs (path, src, target_name, kind, line, col) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of refs) {
    insRef.run(path, r.fromNodeId, r.referenceName, r.referenceKind, r.line, r.column);
  }
  const insEdge = db.prepare(`INSERT INTO file_edges (path, src, dst, kind) VALUES (?, ?, ?, ?)`);
  for (const e of edges) insEdge.run(path, e.source, e.target, e.kind);
};

export interface FileArtifacts {
  refs: UnresolvedReference[];
  edges: Edge[];
}

// Load every file's artifacts, in insertion order. Refs come back in the same
// shape the extractor emits them (language derived from the path), so the
// resolver cannot tell them from a fresh extraction.
export const loadAllFileArtifacts = (db: SqliteAdapter): FileArtifacts => {
  const langByPath = new Map<string, Language>();
  const languageOf = (path: string): Language => {
    let lang = langByPath.get(path);
    if (!lang) {
      lang = detectLanguage(path);
      langByPath.set(path, lang);
    }
    return lang;
  };
  const refRows = db
    .prepare(`SELECT path, src, target_name, kind, line, col FROM file_refs ORDER BY rowid`)
    .all() as {
    path: string;
    src: string;
    target_name: string;
    kind: string;
    line: number;
    col: number;
  }[];
  const refs = refRows.map(
    (r): UnresolvedReference => ({
      fromNodeId: r.src,
      referenceName: r.target_name,
      referenceKind: r.kind as EdgeKind,
      line: r.line,
      column: r.col,
      filePath: r.path,
      language: languageOf(r.path),
    }),
  );
  const edgeRows = db.prepare(`SELECT src, dst, kind FROM file_edges ORDER BY rowid`).all() as {
    src: string;
    dst: string;
    kind: string;
  }[];
  const edges = edgeRows.map(
    (e): Edge => ({ source: e.src, target: e.dst, kind: e.kind as EdgeKind }),
  );
  return { refs, edges };
};
