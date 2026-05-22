import { NotImplemented } from './types.ts';
import type {
  NodeId,
  Provenance,
  RigNode,
  SemanticEdge,
  StructuralEdge,
} from './types.ts';
import type { SqliteAdapter } from './db/adapter.ts';
import type { Embedder } from './embed/types.ts';

export interface RigOptions {
  projectRoot: string;
  db: SqliteAdapter;
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

/**
 * The public API surface of @rig/core. Everything else is internal.
 * Phase 0: all methods are stubs that throw NotImplemented.
 */
export class Rig {
  readonly projectRoot: string;
  readonly db: SqliteAdapter;
  readonly embedder: Embedder | undefined;

  constructor(opts: RigOptions) {
    this.projectRoot = opts.projectRoot;
    this.db = opts.db;
    this.embedder = opts.embedder;
  }

  static async init(_projectRoot: string): Promise<Rig> {
    throw new NotImplemented('Rig.init');
  }

  static async open(_projectRoot: string): Promise<Rig> {
    throw new NotImplemented('Rig.open');
  }

  async status(): Promise<StatusInfo> {
    throw new NotImplemented('Rig.status');
  }

  searchNodes(_query: string): RigNode[] {
    throw new NotImplemented('Rig.searchNodes');
  }

  getNode(_id: NodeId): RigNode | null {
    throw new NotImplemented('Rig.getNode');
  }

  getNeighbors(_id: NodeId): (StructuralEdge | SemanticEdge)[] {
    throw new NotImplemented('Rig.getNeighbors');
  }

  getMagneticPull(_id: NodeId, _k = 10): PullResult[] {
    throw new NotImplemented('Rig.getMagneticPull');
  }

  async addNode(_input: Omit<RigNode, 'created_at' | 'updated_at' | 'pull_score'>, _prov: Provenance): Promise<RigNode> {
    throw new NotImplemented('Rig.addNode');
  }

  close(): void {
    this.db.close();
  }
}
