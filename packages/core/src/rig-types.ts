// SPDX-License-Identifier: Apache-2.0
import type { Database } from './db/database.ts';
import type { Embedder } from './embed/types.ts';

export const RIG_DIR_NAME = '.rig';
export const DB_FILE_NAME = 'rig.db';

export interface RigOptions {
  projectRoot: string;
  database: Database;
  embedder?: Embedder;
}

export interface StatusInfo {
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
}

export interface IndexResult {
  // Files the walk yielded, and the extracted nodes they hold after the run.
  files: number;
  nodes: number;
  // Derived edges rebuilt for the whole project, and unresolved refs.
  edges: number;
  unresolved: number;
  elapsed_ms: number;
  // How the walked files were handled: (re-)extracted, skipped as unchanged,
  // or removed because they are gone from disk.
  changed: number;
  unchanged: number;
  deleted: number;
}
