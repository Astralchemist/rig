import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from './db/database.ts';
import { readCounts } from './db/counts.ts';
import { NotImplemented } from './types.ts';
import type {
  NodeId,
  Provenance,
  RigNode,
  SemanticEdge,
  StructuralEdge,
} from './types.ts';
import type { Embedder } from './embed/types.ts';

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

const rigDirOf = (root: string): string => join(resolve(root), RIG_DIR_NAME);
const dbPathOf = (root: string): string => join(rigDirOf(root), DB_FILE_NAME);

/**
 * The public API surface of @rig/core. Everything else is internal.
 */
export class Rig {
  readonly projectRoot: string;
  readonly database: Database;
  readonly embedder: Embedder | undefined;

  constructor(opts: RigOptions) {
    this.projectRoot = opts.projectRoot;
    this.database = opts.database;
    this.embedder = opts.embedder;
  }

  static async init(projectRoot: string): Promise<Rig> {
    const root = resolve(projectRoot);
    mkdirSync(rigDirOf(root), { recursive: true });
    const database = Database.open(dbPathOf(root));
    return new Rig({ projectRoot: root, database });
  }

  static async open(projectRoot: string): Promise<Rig> {
    const root = resolve(projectRoot);
    if (!existsSync(rigDirOf(root))) {
      throw new Error(`rig: not initialized at ${root}. Run \`rig init\` first.`);
    }
    const database = Database.open(dbPathOf(root));
    return new Rig({ projectRoot: root, database });
  }

  static isInitialized(projectRoot: string): boolean {
    return existsSync(rigDirOf(projectRoot));
  }

  async status(): Promise<StatusInfo> {
    const c = readCounts(this.database.adapter);
    return {
      initialized: true,
      nodes: c.nodes,
      edges_structural: c.edges_structural,
      edges_semantic: c.edges_semantic,
      files: c.files,
      last_sync_ts: c.last_activation_ts,
    };
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

  async addNode(
    _input: Omit<RigNode, 'created_at' | 'updated_at' | 'pull_score'>,
    _prov: Provenance,
  ): Promise<RigNode> {
    throw new NotImplemented('Rig.addNode');
  }

  close(): void {
    this.database.close();
  }
}
