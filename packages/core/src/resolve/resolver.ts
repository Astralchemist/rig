// SPDX-License-Identifier: Apache-2.0
import { EDGE_ORIGIN } from '../db/extracted-nodes.ts';
import type { SqliteAdapter } from '../db/adapter.ts';
import type { Edge, Node, UnresolvedReference } from '../extract/upstream-types.ts';
import { resolveModuleImport } from './import-resolver.ts';
import { loadProjectAliases } from './path-aliases.ts';
import { resolvePythonImport } from './python-modules.ts';

export interface ResolveStats {
  edges: number;
  unresolved: number;
}

// The slice of a node the resolver needs; rebuild-edges.ts loads it for every
// extracted node in the DB.
export type ResolvableNode = Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>;

/**
 * Phase 1.6+ resolver — extract-time direct edges, name-match resolution for
 * non-import refs, tsconfig-paths + relative-path resolution for imports.
 *
 * - Direct edges from the extractor (`contains`, future intra-file edges)
 *   are written verbatim with provenance='ast'; resolved imports get
 *   'ast:import' and unique-name matches 'ast:name' (EDGE_ORIGIN).
 * - Imports use the file-path index + tsconfig.json paths to resolve module
 *   paths to file nodes. Bare specifiers (npm packages) stay unresolved.
 * - Other refs (calls/references/extends/implements) resolved by exact name
 *   match across all known nodes; ambiguous stay in unresolved_refs.
 *
 * Only inserts: the caller (rebuildStructuralEdges) clears the previous 'ast'
 * edges and unresolved_refs and passes every file's artifacts + every
 * extracted node. Edges and refs whose source node is not in `allNodes` are
 * skipped rather than tripping the edges FK.
 */
export const resolveReferences = (
  db: SqliteAdapter,
  allNodes: readonly ResolvableNode[],
  refs: readonly UnresolvedReference[],
  directEdges: readonly Edge[] = [],
  projectRoot?: string,
): ResolveStats => {
  const byName = new Map<string, string[]>();
  const fileByPath = new Map<string, string>();
  const known = new Set<string>();
  for (const n of allNodes) {
    known.add(n.id);
    const ids = byName.get(n.name);
    if (ids) ids.push(n.id);
    else byName.set(n.name, [n.id]);
    if (n.kind === 'file') fileByPath.set(n.filePath, n.id);
  }
  const aliases = projectRoot ? loadProjectAliases(projectRoot) : null;

  const insertEdge = db.prepare(
    'INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertUnresolved = db.prepare(
    'INSERT INTO unresolved_refs (src, target_name, file_path, line, kind) VALUES (?, ?, ?, ?, ?)',
  );

  let edges = 0;
  let unresolved = 0;
  const now = Date.now();

  for (const e of directEdges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    insertEdge.run(e.source, e.target, e.kind, EDGE_ORIGIN.syntax, now);
    edges++;
  }

  for (const ref of refs) {
    if (!known.has(ref.fromNodeId)) continue;
    if (ref.referenceKind === 'imports') {
      const fileId =
        projectRoot && ref.filePath
          ? ref.language === 'python'
            ? resolvePythonImport({
                modulePath: ref.referenceName,
                importedNames: ref.importedNames ?? [],
                importingFile: ref.filePath,
                fileByPath,
              })
            : resolveModuleImport({
                modulePath: ref.referenceName,
                importingFile: ref.filePath,
                fileByPath,
                projectRoot,
                aliases,
              })
          : null;
      if (fileId && fileId !== ref.fromNodeId) {
        insertEdge.run(ref.fromNodeId, fileId, 'imports', EDGE_ORIGIN.import, now);
        edges++;
      } else {
        insertUnresolved.run(
          ref.fromNodeId,
          ref.referenceName,
          ref.filePath ?? '',
          ref.line,
          ref.referenceKind,
        );
        unresolved++;
      }
      continue;
    }
    if (ref.viaCallee) {
      // Callback: link the receiving function to the one it was handed.
      const callee = byName.get(ref.viaCallee);
      const target = byName.get(ref.referenceName);
      if (callee?.length === 1 && target?.length === 1 && callee[0] !== target[0]) {
        insertEdge.run(callee[0]!, target[0]!, 'calls', EDGE_ORIGIN.callback, now);
        edges++;
      }
      continue;
    }
    const cands = byName.get(ref.referenceName);
    if (cands && cands.length === 1 && cands[0] !== ref.fromNodeId) {
      insertEdge.run(ref.fromNodeId, cands[0]!, ref.referenceKind, EDGE_ORIGIN.name, now);
      edges++;
    } else {
      insertUnresolved.run(
        ref.fromNodeId,
        ref.referenceName,
        ref.filePath ?? '',
        ref.line,
        ref.referenceKind,
      );
      unresolved++;
    }
  }
  return { edges, unresolved };
};
