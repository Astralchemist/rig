import type { Database } from './db/database.ts';
import type { Embedder } from './embed/types.ts';
import type { NodeId } from './types.ts';

export const RIG_DIR_NAME = '.rig';
export const DB_FILE_NAME = 'rig.db';

export interface RigOptions {
  projectRoot: string;
  database: Database;
  embedder?: Embedder;
}

export interface PullResult {
  nodeId: NodeId;
  score: number;
  components: { structural: number; semantic: number; recency: number };
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
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  elapsed_ms: number;
}
