import type { SqliteAdapter } from '../db/adapter.ts';
import type { Edge, Node, UnresolvedReference } from '../extract/upstream-types.ts';
import { resolveModuleImport } from './import-resolver.ts';
import { loadProjectAliases } from './path-aliases.ts';

export interface ResolveStats {
  edges: number;
  unresolved: number;
}

/**
 * Phase 1.6+ resolver — extract-time direct edges, name-match resolution for
 * non-import refs, tsconfig-paths + relative-path resolution for imports.
 *
 * - Direct edges from the extractor (`contains`, future intra-file edges)
 *   are written verbatim with provenance='ast'.
 * - Imports use the file-path index + tsconfig.json paths to resolve module
 *   paths to file nodes. Bare specifiers (npm packages) stay unresolved.
 * - Other refs (calls/references/extends/implements) resolved by exact name
 *   match across all known nodes; ambiguous stay in unresolved_refs.
 */
export const resolveReferences = (
  db: SqliteAdapter,
  allNodes: Node[],
  refs: UnresolvedReference[],
  directEdges: Edge[] = [],
  projectRoot?: string,
): ResolveStats => {
  const byName = new Map<string, string[]>();
  const fileByPath = new Map<string, string>();
  for (const n of allNodes) {
    const ids = byName.get(n.name);
    if (ids) ids.push(n.id);
    else byName.set(n.name, [n.id]);
    if (n.kind === 'file') fileByPath.set(n.filePath, n.id);
  }
  const aliases = projectRoot ? loadProjectAliases(projectRoot) : null;

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
      const fileId =
        projectRoot && ref.filePath
          ? resolveModuleImport({
              modulePath: ref.referenceName,
              importingFile: ref.filePath,
              fileByPath,
              projectRoot,
              aliases,
            })
          : null;
      if (fileId && fileId !== ref.fromNodeId) {
        insertEdge.run(ref.fromNodeId, fileId, 'imports', 'ast', now);
        edges++;
      } else {
        insertUnresolved.run(ref.fromNodeId, ref.referenceName, ref.filePath ?? '', ref.line);
        unresolved++;
      }
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
