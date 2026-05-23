import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from './db/database.ts';
import { readCounts } from './db/counts.ts';
import {
  countNeighborsByKind,
  getNeighbors as eqGetNeighbors,
  type NeighborsOptions,
  type TaggedEdge,
} from './db/edge-queries.ts';
import { getFiles as fqGetFiles, type FileRow } from './db/file-queries.ts';
import {
  getGraphSnapshot as gsGetGraphSnapshot,
  type GraphSnapshot,
} from './db/graph-snapshot.ts';
import { searchNodes as sqSearchNodes, type SearchOptions } from './db/search-queries.ts';
import { selectEmbedder } from './embed/select.ts';
import type { Embedder } from './embed/types.ts';
import {
  getCallees as gqGetCallees,
  getCallers as gqGetCallers,
  getImpactRadius as gqGetImpactRadius,
  getNode as gqGetNode,
} from './graph/traversal.ts';
import { runIndexAll } from './index-all.ts';
import { computeMagneticPull, type PullResult } from './pull.ts';
import { drillFromHub, type DrillResult } from './graph/hub-drill.ts';
import { getTopHubs, hubsOf, promoteHub, type HubRef } from './graph/hubness.ts';
import { dbPathOf, rigDirOf, toRigNode } from './rig-shape.ts';
import { DB_FILE_NAME, RIG_DIR_NAME } from './rig-types.ts';
import type { IndexResult, RigOptions, StatusInfo } from './rig-types.ts';
import { RigWrites } from './rig-writes.ts';
import { runSync, type SyncResult } from './sync.ts';
import type { NodeId, RigNode } from './types.ts';
import { FileWatcher } from './watch.ts';

export { DB_FILE_NAME, RIG_DIR_NAME };
export type { IndexResult, RigOptions, StatusInfo };
export type { PullResult } from './pull.ts';
export type { HubRef } from './graph/hubness.ts';
export type { DrillResult } from './graph/hub-drill.ts';
export type { SyncResult } from './sync.ts';
export type { TaggedEdge, NeighborsOptions } from './db/edge-queries.ts';
export type { SearchOptions } from './db/search-queries.ts';
export type { FileRow } from './db/file-queries.ts';
export type { GraphSnapshot } from './db/graph-snapshot.ts';
export type { PendingEdgeRow } from './db/pending-edges.ts';
export type { MutationRow, MutationKind } from './db/mutation-log.ts';
export { RigWrites } from './rig-writes.ts';
export type { WriteCtx, ProposeArgs, AddNodeArgs } from './rig-writes.ts';

export class Rig {
  readonly projectRoot: string;
  readonly database: Database;
  readonly embedder: Embedder | undefined;
  readonly writes: RigWrites;
  private watcher: FileWatcher | null = null;

  constructor(opts: RigOptions) {
    this.projectRoot = opts.projectRoot;
    this.database = opts.database;
    this.embedder = opts.embedder;
    this.writes = new RigWrites(this.database);
  }

  static async init(
    projectRoot: string,
    opts: { embedder?: Embedder } = {},
  ): Promise<Rig> {
    const root = resolve(projectRoot);
    mkdirSync(rigDirOf(root), { recursive: true });
    return new Rig({
      projectRoot: root,
      database: Database.open(dbPathOf(root)),
      embedder: opts.embedder ?? selectEmbedder(root),
    });
  }

  static async open(
    projectRoot: string,
    opts: { embedder?: Embedder } = {},
  ): Promise<Rig> {
    const root = resolve(projectRoot);
    if (!existsSync(rigDirOf(root))) {
      throw new Error(`rig: not initialized at ${root}. Run \`rig init\` first.`);
    }
    return new Rig({
      projectRoot: root,
      database: Database.open(dbPathOf(root)),
      embedder: opts.embedder ?? selectEmbedder(root),
    });
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
    return runIndexAll(this.projectRoot, this.database, this.embedder);
  }

  sync(): Promise<SyncResult> {
    return runSync(this.projectRoot, this.database, this.embedder);
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

  searchNodes(query: string, opts: SearchOptions = {}): RigNode[] {
    return sqSearchNodes(this.database.adapter, query, opts).map(toRigNode);
  }

  getNeighbors(id: NodeId, opts: NeighborsOptions = {}): TaggedEdge[] {
    return eqGetNeighbors(this.database.adapter, id, opts);
  }

  getNeighborCounts(id: NodeId): Record<string, number> {
    return countNeighborsByKind(this.database.adapter, id);
  }

  getFiles(filter?: string): FileRow[] {
    return fqGetFiles(this.database.adapter, filter);
  }

  snapshot(limit = 500): GraphSnapshot {
    return gsGetGraphSnapshot(this.database.adapter, limit);
  }

  getTopHubs(opts: { scope?: string; limit?: number } = {}): HubRef[] {
    return getTopHubs(this.database.adapter, opts);
  }

  getHubsOf(id: NodeId, maxDepth = 3): HubRef[] {
    return hubsOf(this.database.adapter, id, maxDepth);
  }

  drillFromHub(
    hubId: NodeId,
    opts: { query?: string; maxDepth?: number; limit?: number } = {},
  ): DrillResult[] {
    return drillFromHub(this.database.adapter, hubId, opts);
  }

  promoteHub(id: NodeId): boolean {
    return promoteHub(this.database.adapter, id);
  }

  getMagneticPull(id: NodeId, k = 10): PullResult[] {
    const candidates = (
      this.database.adapter
        .prepare('SELECT id FROM nodes WHERE id != ?')
        .all(id) as { id: string }[]
    ).map((r) => r.id);
    return computeMagneticPull(id, candidates, { db: this.database.adapter }).slice(0, k);
  }

  watch(): boolean {
    if (this.watcher) return true;
    this.watcher = new FileWatcher(this.projectRoot, () => this.sync());
    return this.watcher.start();
  }

  unwatch(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  close(): void {
    this.unwatch();
    this.database.close();
  }
}
