// SPDX-License-Identifier: Apache-2.0
import type { Database } from './db/database.ts';
import type { Embedder } from './embed/types.ts';
import type { WalkOptions } from './extract/walker.ts';
import type { IndexResult } from './rig-types.ts';
import { runUpdate, type IndexProgress } from './update.ts';

export type { IndexProgress } from './update.ts';

// `rig index`: the shared update pipeline (update.ts) in index mode. With
// include/exclude globs only the matching files are re-extracted; every other
// file keeps its nodes and edges.
export async function runIndexAll(
  projectRoot: string,
  database: Database,
  embedder?: Embedder,
  onProgress?: (p: IndexProgress) => void,
  walkOpts?: WalkOptions,
): Promise<IndexResult> {
  const r = await runUpdate(projectRoot, database, embedder, {
    mode: 'index',
    walk: walkOpts,
    onProgress,
  });
  return {
    files: r.files,
    nodes: r.nodes,
    edges: r.edges,
    unresolved: r.unresolved,
    elapsed_ms: r.elapsedMs,
    changed: r.changed,
    unchanged: r.unchanged,
    deleted: r.deleted,
  };
}
