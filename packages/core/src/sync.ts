// SPDX-License-Identifier: Apache-2.0
import type { Database } from './db/database.ts';
import type { Embedder } from './embed/types.ts';
import { runUpdate } from './update.ts';

export interface SyncResult {
  filesChanged: number;
  filesPurged: number;
  durationMs: number;
  // Deleted nodes whose agent-written memory went to orphaned_memory, and
  // orphan rows re-attached to re-created nodes.
  orphaned: number;
  reattached: number;
}

/**
 * Incremental sync: the shared update pipeline (update.ts) in sync mode.
 * Re-extracts files whose content changed, removes files that disappeared,
 * and rebuilds the structural edges of the whole project from the per-file
 * artifacts, so changed files keep their calls/imports edges.
 */
export async function runSync(
  projectRoot: string,
  database: Database,
  embedder?: Embedder,
): Promise<SyncResult> {
  const r = await runUpdate(projectRoot, database, embedder, { mode: 'sync' });
  return {
    filesChanged: r.changed,
    filesPurged: r.deleted,
    durationMs: r.elapsedMs,
    orphaned: r.orphaned,
    reattached: r.reattached,
  };
}
