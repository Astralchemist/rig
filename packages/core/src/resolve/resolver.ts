import type { SqliteAdapter } from '../db/adapter.ts';
import type { Node, UnresolvedReference } from '../extract/upstream-types.ts';

export interface ResolveStats {
  edges: number;
  unresolved: number;
}

/**
 * Phase 1.3 resolver — minimal but honest.
 *
 * - Calls resolved by exact name match across all known nodes; if exactly one
 *   candidate, write a 'calls' edge with provenance='ast'. Ambiguous matches
 *   stay in unresolved_refs (refusing false positives).
 * - Imports recorded as unresolved_refs (module-path → file resolution is
 *   Phase 1.6+; depends on tsconfig path aliases we explicitly deferred).
 */
export const resolveReferences = (
  db: SqliteAdapter,
  allNodes: Node[],
  refs: UnresolvedReference[],
): ResolveStats => {
  const byName = new Map<string, string[]>();
  for (const n of allNodes) {
    const ids = byName.get(n.name);
    if (ids) ids.push(n.id);
    else byName.set(n.name, [n.id]);
  }

  db.exec('DELETE FROM edges WHERE provenance = \'ast\'');
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
