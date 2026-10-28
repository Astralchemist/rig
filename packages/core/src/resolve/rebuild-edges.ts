// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';
import { loadExtractedNodes } from '../db/extracted-nodes.ts';
import { loadAllFileArtifacts } from '../db/file-artifacts.ts';
import { resolveReferences, type ResolveStats } from './resolver.ts';

// Provenance of every edge derived from extraction (direct edges and resolved
// refs written by resolver.ts, tests edges by graph/tests-edges.ts). Anything
// else on `edges` was written by an actor (waypoint_references,
// waypoint_succeeds, cluster membership) and is never touched here.
export const DERIVED_EDGE_PROVENANCE = 'ast';

// Files rows that predate v12 (extractor_version IS NULL) have no artifacts
// yet. One survives an update only when a filtered index (--include/--exclude)
// skipped it after the upgrade; its existing edges and unresolved refs are
// kept as-is until it is re-extracted.
const LEGACY_PATHS_SQL = `SELECT path FROM files WHERE extractor_version IS NULL`;

const clearDerivedEdges = (db: SqliteAdapter): void => {
  const legacy = (
    db.prepare(`SELECT COUNT(*) AS n FROM (${LEGACY_PATHS_SQL})`).get() as {
      n: number;
    }
  ).n;
  if (legacy === 0) {
    db.prepare(`DELETE FROM edges WHERE provenance = ?`).run(DERIVED_EDGE_PROVENANCE);
    db.exec('DELETE FROM unresolved_refs');
    return;
  }
  db.prepare(
    `DELETE FROM edges WHERE provenance = ? AND src NOT IN (
       SELECT id FROM nodes WHERE json_extract(data, '$.filePath') IN (${LEGACY_PATHS_SQL})
     )`,
  ).run(DERIVED_EDGE_PROVENANCE);
  db.exec(`DELETE FROM unresolved_refs WHERE file_path NOT IN (${LEGACY_PATHS_SQL})`);
};

// Recompute every derived structural edge and unresolved_refs row from the
// per-file artifacts of ALL files, resolving names against every extracted
// node in the DB. A partial index, a sync or a skipped file therefore never
// drops another file's edges, and resolution changes elsewhere (a new
// same-named symbol making a call ambiguous, a deleted target) are reflected.
// Run inside the caller's transaction.
export const rebuildStructuralEdges = (db: SqliteAdapter, projectRoot?: string): ResolveStats => {
  const nodes = loadExtractedNodes(db);
  const { refs, edges } = loadAllFileArtifacts(db);
  clearDerivedEdges(db);
  return resolveReferences(db, nodes, refs, edges, projectRoot);
};
