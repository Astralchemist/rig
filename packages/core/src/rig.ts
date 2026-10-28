// SPDX-License-Identifier: Apache-2.0
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
import {
  listCold as aqListCold,
  listHotspots as aqListHotspots,
  type ColdRow,
  type HotspotRow,
} from './db/activation-queries.ts';
import {
  listDependencies as dqListDependencies,
  listDependencyConflicts as dqListConflicts,
  listPhantomImports as dqListPhantom,
  listUnusedDependencies as dqListUnused,
  type DepConflictRow,
  type DepRow,
  type PhantomImportRow,
  type UnusedDepRow,
} from './db/dep-queries.ts';
import {
  getWaypoint as wqGet,
  getWaypointChain as wqChain,
  listWaypoints as wqList,
  type ListWaypointsOpts,
  type WaypointRow,
} from './db/waypoint-queries.ts';
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
import { listAliases, type AliasRow } from './db/alias-queries.ts';
import { listAnnotations, type AnnotationRow } from './db/annotation-queries.ts';
import { computeCriticalPath, type CriticalStep } from './graph/critical-path.ts';
import { drillFromHub, type DrillResult } from './graph/hub-drill.ts';
import { getTopHubs, hubsOf, promoteHub, type HubRef } from './graph/hubness.ts';
import { dbPathOf, rigDirOf, toRigNode } from './rig-shape.ts';
import { DB_FILE_NAME, RIG_DIR_NAME } from './rig-types.ts';
import type { IndexResult, RigOptions, StatusInfo } from './rig-types.ts';
import { RigWrites } from './rig-writes.ts';
import { runSync, type SyncResult } from './sync.ts';
import type { NodeId, RigNode } from './types.ts';
import { FileWatcher, type WatchOptions } from './watch.ts';
import { acquireWatchLock, type WatchLock } from './watch-lock.ts';
import { logWarn } from './errors.ts';
import { watchDisabledReason } from './watch-policy.ts';

export { DB_FILE_NAME, RIG_DIR_NAME };
export type { IndexResult, RigOptions, StatusInfo };
export type { PullResult } from './pull.ts';
export type { HubRef } from './graph/hubness.ts';
export type { DrillResult } from './graph/hub-drill.ts';
export type { CriticalStep } from './graph/critical-path.ts';
export type { AliasRow } from './db/alias-queries.ts';
export type { AnnotationRow } from './db/annotation-queries.ts';
export type {
  DepRow,
  DepConflictRow,
  UnusedDepRow,
  PhantomImportRow,
} from './db/dep-queries.ts';
export type { HotspotRow, ColdRow } from './db/activation-queries.ts';
export type {
  WaypointRow,
  WaypointKind,
  WaypointPayload,
  ListWaypointsOpts,
} from './db/waypoint-queries.ts';
export type { SyncResult } from './sync.ts';
export type { WatchOptions } from './watch.ts';
export type { TaggedEdge, NeighborsOptions } from './db/edge-queries.ts';
export type { SearchOptions } from './db/search-queries.ts';
export type { FileRow } from './db/file-queries.ts';
export type { GraphSnapshot } from './db/graph-snapshot.ts';
export type { PendingEdgeRow } from './db/pending-edges.ts';
export type { MutationRow, MutationKind } from './db/mutation-log.ts';
export { RigWrites, UnknownRefsError } from './rig-writes.ts';
export type { WriteCtx, ProposeArgs, AddNodeArgs, UndoOutcome } from './rig-writes.ts';

export interface RigWatchOptions extends WatchOptions {
  // How often a process that did not get the watch lock tries again, so it
  // takes over when the current watcher exits. Default: 30s
  lockRetryMs?: number;
}

export class Rig {
  readonly projectRoot: string;
  readonly database: Database;
  readonly embedder: Embedder | undefined;
  readonly writes: RigWrites;
  private watcher: FileWatcher | null = null;
  private watchLock: WatchLock | null = null;
  private watchRetry: ReturnType<typeof setInterval> | null = null;
  // indexAll/sync runs on this connection, chained so a watcher sync never
  // interleaves with an explicit index.
  private updates: Promise<unknown> = Promise.resolve();

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
      last_sync_ts:
        c.last_index_ts === null || c.last_sync_ts === null
          ? (c.last_index_ts ?? c.last_sync_ts)
          : Math.max(c.last_index_ts, c.last_sync_ts),
      last_index_ts: c.last_index_ts,
      orphans: c.orphans,
    };
  }

  indexAll(opts: {
    onProgress?: (p: import('./index-all.ts').IndexProgress) => void;
    include?: readonly string[];
    exclude?: readonly string[];
    // Re-extract every walked file, even unchanged ones (still in place).
    force?: boolean;
  } = {}): Promise<IndexResult> {
    return this.serialized(() =>
      runIndexAll(
        this.projectRoot,
        this.database,
        this.embedder,
        opts.onProgress,
        {
          include: opts.include,
          exclude: opts.exclude,
        },
        { force: opts.force === true },
      ),
    );
  }

  sync(): Promise<SyncResult> {
    return this.serialized(() => runSync(this.projectRoot, this.database, this.embedder));
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.updates.then(run, run);
    this.updates = next.catch(() => {});
    return next;
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

  getAliases(id: NodeId): AliasRow[] {
    return listAliases(this.database.adapter, id);
  }

  getAnnotations(id: NodeId): AnnotationRow[] {
    return listAnnotations(this.database.adapter, id);
  }

  getDependencies(manifestPath?: string): DepRow[] {
    return dqListDependencies(this.database.adapter, manifestPath);
  }

  getDependencyConflicts(): DepConflictRow[] {
    return dqListConflicts(this.database.adapter);
  }

  getUnusedDependencies(): UnusedDepRow[] {
    return dqListUnused(this.database.adapter);
  }

  getPhantomImports(): PhantomImportRow[] {
    return dqListPhantom(this.database.adapter);
  }

  // C4 — register the AI's tool surface as skill anchors. Caller supplies the
  // tools-manifest (MCP layer owns it); core stays manifest-format-agnostic.
  // D4 — return top-k skills most relevant to a free-text query. Mirrors
  // rig_search but joins through to the skill payload so the caller gets the
  // tier + description without a second roundtrip. Falls back to a name-prefix
  // scan if FTS yields nothing (FTS quirks with short queries / underscores).
  getRelevantSkills(
    query: string,
    k = 5,
  ): Array<{ id: string; name: string; tier: string; summary: string | null; description: string }> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const adapter = this.database.adapter;
    const fts = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' ');
    let rows = adapter
      .prepare(
        `SELECT n.id, n.name, n.data, bm25(nodes_fts) AS rank
         FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
         WHERE nodes_fts MATCH ? AND n.type = 'skill'
         ORDER BY rank
         LIMIT ?`,
      )
      .all(fts, k) as { id: string; name: string; data: string; rank: number }[];
    if (rows.length === 0) {
      rows = adapter
        .prepare(
          `SELECT id, name, data, 0 AS rank FROM nodes
           WHERE type = 'skill' AND name LIKE ?
           ORDER BY name LIMIT ?`,
        )
        .all(`%${trimmed}%`, k) as { id: string; name: string; data: string; rank: number }[];
    }
    return rows.map((r) => {
      const d = JSON.parse(r.data) as { tier?: string; summary?: string; description?: string };
      return {
        id: r.id,
        name: r.name,
        tier: d.tier ?? 'light',
        summary: d.summary ?? null,
        description: d.description ?? '',
      };
    });
  }

  seedSkills(
    tools: ReadonlyArray<{ name: string; description: string; tier: string; summary?: string; records_activation?: boolean }>,
  ): number {
    let n = 0;
    for (const t of tools) {
      this.writes.upsertSkill({
        name: t.name,
        description: t.description,
        tier: t.tier,
        summary: t.summary,
        recordsActivation: t.records_activation === true,
      });
      n++;
    }
    return n;
  }

  getHotspots(opts: { windowMs?: number; limit?: number } = {}): HotspotRow[] {
    return aqListHotspots(this.database.adapter, opts.windowMs, opts.limit);
  }

  getCold(opts: { staleAfterMs?: number; limit?: number } = {}): ColdRow[] {
    return aqListCold(this.database.adapter, opts.staleAfterMs, opts.limit);
  }

  getWaypoints(opts: ListWaypointsOpts = {}): WaypointRow[] {
    return wqList(this.database.adapter, opts);
  }

  getWaypoint(id: string): WaypointRow | null {
    return wqGet(this.database.adapter, id);
  }

  getWaypointChain(id: string, maxDepth = 10): WaypointRow[] {
    return wqChain(this.database.adapter, id, maxDepth);
  }

  getCriticalPath(id: NodeId, maxSteps = 16): CriticalStep[] {
    return computeCriticalPath(this.database.adapter, id, maxSteps);
  }

  getMagneticPull(id: NodeId, k = 10, opts: { hubBias?: number } = {}): PullResult[] {
    const candidates = (
      this.database.adapter
        .prepare('SELECT id FROM nodes WHERE id != ?')
        .all(id) as { id: string }[]
    ).map((r) => r.id);
    // Default hubBias=0.3 so light-tier callers (rig_pull) surface hubs first.
    // Callers wanting unbiased ranking pass hubBias=0 (e.g. hub-drill).
    return computeMagneticPull(id, candidates, {
      db: this.database.adapter,
      hubBias: opts.hubBias ?? 0.3,
    }).slice(0, k);
  }

  // Keep the graph live: watch the project and sync on change. At most one
  // watcher runs per project across processes (watch-lock.ts); an instance
  // that does not get the lock retries every lockRetryMs and takes over once
  // the holder exits. Respects watch-policy.ts (RIG_NO_WATCH=1, WSL2 /mnt).
  // Returns true when this instance is now the watcher.
  watch(opts: RigWatchOptions = {}): boolean {
    if (this.watcher) return true;
    if (watchDisabledReason(this.projectRoot) !== null) return false;
    const started = this.startWatching(opts);
    if (started !== 'locked') return started === 'started';
    if (!this.watchRetry) {
      this.watchRetry = setInterval(() => {
        if (this.startWatching(opts) !== 'locked') this.stopWatchRetry();
      }, opts.lockRetryMs ?? 30_000);
      this.watchRetry.unref?.();
    }
    return false;
  }

  // Also runs from timers (lock retry, heartbeat step-down), so it never throws:
  // a failure leaves the graph unwatched rather than crashing the server.
  private startWatching(opts: RigWatchOptions): 'started' | 'locked' | 'unavailable' {
    let lock: WatchLock | null = null;
    let watcher: FileWatcher;
    try {
      lock = acquireWatchLock(rigDirOf(this.projectRoot), {
        // Someone took the lock over (we looked stale): step down and retry.
        onLost: () => {
          this.watchLock = null;
          this.unwatch();
          this.watch(opts);
        },
      });
      if (!lock) return 'locked';
      watcher = new FileWatcher(this.projectRoot, () => this.sync(), opts);
      if (!watcher.start()) {
        lock.release();
        return 'unavailable';
      }
    } catch (e) {
      logWarn('Could not start the file watcher', { error: String(e) });
      lock?.release();
      return 'unavailable';
    }
    this.watcher = watcher;
    this.watchLock = lock;
    // Catch up on edits made while no watcher ran (never-indexed projects are
    // left to an explicit `rig index`).
    try {
      if (this.database.adapter.prepare(`SELECT 1 AS x FROM files LIMIT 1`).get()) {
        watcher.requestSync();
      }
    } catch {
      // the next file change syncs anyway
    }
    return 'started';
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  private stopWatchRetry(): void {
    if (this.watchRetry) clearInterval(this.watchRetry);
    this.watchRetry = null;
  }

  unwatch(): void {
    this.stopWatchRetry();
    this.watcher?.stop();
    this.watcher = null;
    this.watchLock?.release();
    this.watchLock = null;
  }

  close(): void {
    this.unwatch();
    this.database.close();
  }
}
