import type { SqliteAdapter } from '../db/adapter.ts';
import type { Edge, Node, UnresolvedReference } from '../extract/upstream-types.ts';

export interface ResolveStats {
  edges: number;
  unresolved: number;
}

/**
 * Phase 1.6+ resolver — extract-time direct edges (e.g. `contains`) plus
 * by-name reference resolution.
 *
 * - Direct edges from the extractor (`contains`, future intra-file edges)
 *   are written verbatim with provenance='ast'.
 * - Refs resolved by exact name match across all known nodes; ambiguous
 *   stay in unresolved_refs (refusing false positives).
 * - Imports stay unresolved (module-path → file resolution depends on
 *   tsconfig path aliases that we explicitly deferred).
 */
export const resolveReferences = (
  db: SqliteAdapter,
  allNodes: Node[],
  refs: UnresolvedReference[],
  directEdges: Edge[] = [],
): ResolveStats => {
  const byName = new Map<string, string[]>();
  for (const n of allNodes) {
    const ids = byName.get(n.name);
    if (ids) ids.push(n.id);
    else byName.set(n.name, [n.id]);
  }

  db.exec("DELETE FROM edges WHERE provenance = 'ast'");
  db.exec('DELETE FROM unresolved_refs');

  const insertEdge = db.prepare(
    'INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertUnresolved = db.prepare(
    'INSERT INTO unresolved_refs (src, target_name, file_path, line) VALUES (?, ?, ?, ?)',
  );

  let edges = 0;
  let unresolved = 0;
  const now = Date.now();

  for (const e of directEdges) {
    insertEdge.run(e.source, e.target, e.kind, 'ast', now);
    edges++;
  }

  for (const ref of refs) {
    if (ref.referenceKind === 'imports') {
      insertUnresolved.run(ref.fromNodeId, ref.referenceName, ref.filePath ?? '', ref.line);
      unresolved++;
      continue;
    }
    const cands = byName.get(ref.referenceName);
    if (cands && cands.length === 1 && cands[0] !== ref.fromNodeId) {
      insertEdge.run(ref.fromNodeId, cands[0]!, ref.referenceKind, 'ast', now);
      edges++;
    } else {
      insertUnresolved.run(ref.fromNodeId, ref.referenceName, ref.filePath ?? '', ref.line);
      unresolved++;
    }
  }
  return { edges, unresolved };
};
