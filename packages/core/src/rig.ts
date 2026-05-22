import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from './db/database.ts';
import { readCounts } from './db/counts.ts';
import type { Node as ExtractNode } from './extract/upstream-types.ts';
import {
  getCallees as gqGetCallees,
  getCallers as gqGetCallers,
  getImpactRadius as gqGetImpactRadius,
  getNode as gqGetNode,
} from './graph/traversal.ts';
import { runIndexAll } from './index-all.ts';
import { computeMagneticPull, type PullResult } from './pull.ts';
import {
  DB_FILE_NAME,
  RIG_DIR_NAME,
  type IndexResult,
  type RigOptions,
  type StatusInfo,
} from './rig-types.ts';
import { NotImplemented } from './types.ts';
import type {
  NodeId,
  Provenance,
  RigNode,
  SemanticEdge,
  StructuralEdge,
} from './types.ts';
import type { Embedder } from './embed/types.ts';

export { DB_FILE_NAME, RIG_DIR_NAME };
export type { IndexResult, RigOptions, StatusInfo };
export type { PullResult } from './pull.ts';

const rigDirOf = (root: string): string => join(resolve(root), RIG_DIR_NAME);
const dbPathOf = (root: string): string => join(rigDirOf(root), DB_FILE_NAME);

const toRigNode = (n: ExtractNode): RigNode => ({
  id: n.id,
  type: n.kind,
  name: n.name,
  data: n as unknown as Record<string, unknown>,
  pull_score: 0,
  created_at: n.updatedAt,
  updated_at: n.updatedAt,
});

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

  indexAll(): Promise<IndexResult> {
    return runIndexAll(this.projectRoot, this.database);
  }

  getNode(id: NodeId): RigNode | null {
    const n = gqGetNode(this.database.adapter, id);
    return n ? toRigNode(n) : null;
  }

  getCallers(id: NodeId): RigNode[] {
    return gqGetCallers(this.database.adapter, id).map(toRigNode);
  }

  getCallees(id: NodeId): RigNode[] {
    return gqGetCallees(this.database.adapter, id).map(toRigNode);
  }

  getImpactRadius(id: NodeId, depth = 3): RigNode[] {
    return gqGetImpactRadius(this.database.adapter, id, depth).map(toRigNode);
  }

  searchNodes(_query: string): RigNode[] {
    throw new NotImplemented('Rig.searchNodes');
  }

  getNeighbors(_id: NodeId): (StructuralEdge | SemanticEdge)[] {
    throw new NotImplemented('Rig.getNeighbors');
  }

  getMagneticPull(id: NodeId, k = 10): PullResult[] {
    const candidates = (
      this.database.adapter
        .prepare('SELECT id FROM nodes WHERE id != ?')
        .all(id) as { id: string }[]
    ).map((r) => r.id);
    return computeMagneticPull(id, candidates, { db: this.database.adapter }).slice(0, k);
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
