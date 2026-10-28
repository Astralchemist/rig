// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SqliteAdapter } from './db/adapter.ts';
import type { Database } from './db/database.ts';
import { enrichDependenciesFromLockfiles } from './db/dep-resolution.ts';
import { EXTRACTED_KINDS_SQL, EXTRACTED_NODE_SQL } from './db/extracted-nodes.ts';
import { replaceFileArtifacts } from './db/file-artifacts.ts';
import { META_LAST_INDEX_TS, META_LAST_SYNC_TS, setMeta } from './db/meta.ts';
import { pickData, upsertFile } from './db/node-queries.ts';
import {
  reattachOrphans,
  snapshotOrphans,
  type AnchoredNode,
  type OrphanReason,
} from './db/orphaned-memory.ts';
import {
  EMBEDDED_AGENT_KINDS,
  STALE_EMBEDDING_SQL,
  embedAndStore,
  embeddableOf,
  type EmbeddableNode,
} from './embed/index-embeddings.ts';
import type { Embedder } from './embed/types.ts';
import { EXTRACTOR_VERSION, extractFromSource } from './extract/extractor.ts';
import type { ExtractionResult, Node as ExtractNode, NodeKind } from './extract/upstream-types.ts';
import { makeWalkFilter, walkProject, type WalkOptions } from './extract/walker.ts';
import { detectCommunities } from './graph/communities.ts';
import { recomputeHubness, recomputeHubnessForFiles } from './graph/hubness.ts';
import { inferTestsEdges } from './graph/tests-edges.ts';
import {
  positionOrdinals,
  reconcileNodes,
  type ReconciledNode,
  type StoredNode,
} from './reconcile-nodes.ts';
import { rebuildStructuralEdges } from './resolve/rebuild-edges.ts';

// The one update pipeline behind `rig index`, `rig sync` and the file watcher:
//   1. walk the project
//   2. classify each file as changed, unchanged or deleted
//   3. extract changed files
//   4. update them in place (reconcile-nodes.ts): matched nodes keep their id
//      and row, so aliases, promotes, edges, annotations and embeddings that
//      hang off them survive; only nodes that no longer exist are removed
//   5. snapshot the agent-written memory of removed nodes into
//      orphaned_memory, delete them and the files rows of deleted files, and
//      re-attach orphaned memory to re-created nodes with the same anchor
//   6. rebuild the derived ('ast') edges from the artifacts of ALL files
//   7. tests-edges, hubness, lockfile enrichment and communities
//   8. record the completion time in meta (last_index_ts / last_sync_ts), so
//      status can tell when the graph last matched the files
//   9. embed the changed nodes, and any extracted node, waypoint or skill
//      still missing a vector from the current model or embedded from an
//      older version of its embedding text
// Steps 4–6 and the tests edges run in one transaction, so readers never see
// a file's nodes without its edges. The slow, fallible embedding runs last: if
// it fails, the graph is already complete and the next run embeds what is
// missing (sync does not skip while vectors are missing).

export interface IndexProgress {
  phase: 'extract' | 'resolve' | 'embed' | 'tests-edges' | 'hubness' | 'communities';
  current?: number;
  total?: number;
  detail?: string;
}

export interface UpdateOptions {
  // 'index' (`rig index`, `rig start`): full hubness recompute + communities,
  // and the edge rebuild runs even when no file changed.
  // 'sync' (`rig sync`, the watcher): the cheaper incremental tail; with no
  // file changes it only embeds nodes still missing a vector, if any.
  mode: 'index' | 'sync';
  // include/exclude globs. Only files the filtered walk could yield are
  // re-extracted or treated as deleted.
  walk?: WalkOptions | undefined;
  // Re-extract every walked file even when unchanged (still in place).
  force?: boolean | undefined;
  onProgress?: ((p: IndexProgress) => void) | undefined;
}

export interface UpdateResult {
  // Files the walk yielded.
  files: number;
  // Files (re-)extracted this run.
  changed: number;
  // Files skipped: same content hash and extractor version as stored.
  unchanged: number;
  // Known files gone from disk (within the walk filter), now removed.
  deleted: number;
  // Extracted nodes belonging to the walked files after the update.
  nodes: number;
  // Derived edges written by the rebuild, and unresolved refs it recorded.
  edges: number;
  unresolved: number;
  // Nodes whose embedding was (re)computed.
  embedded: number;
  // orphaned_memory rows written for deleted nodes, and rows re-attached.
  orphaned: number;
  reattached: number;
  elapsedMs: number;
}

interface ChangedFile {
  path: string;
  hash: string;
  mtime: number;
  result: ExtractionResult;
}

interface StoredRow {
  id: string;
  type: string;
  name: string;
  data: string;
}

const hashOf = (source: string): string =>
  createHash('sha256').update(source).digest('hex').slice(0, 16);

const isBusy = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) ||
    /database is locked/i.test(e instanceof Error ? e.message : String(e))
  );
};

// Another rig process (a watcher in an MCP server, a CLI `rig index`) may hold
// the write lock. Each step retried here reads and writes in one go and rolls
// back on failure, so it is simply run again.
const retryWhenBusy = async <T>(run: () => T | Promise<T>, attempts = 6): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (!isBusy(e) || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
};

const loadStoredRows = (db: SqliteAdapter, path: string): StoredRow[] =>
  db
    .prepare(
      `SELECT id, type, name, data FROM nodes
       WHERE json_extract(data, '$.filePath') = ? AND type IN ${EXTRACTED_KINDS_SQL}`,
    )
    .all(path) as StoredRow[];

const storedNodeOf = (r: StoredRow): StoredNode => {
  const d = JSON.parse(r.data) as Partial<ExtractNode>;
  return {
    id: r.id,
    kind: r.type,
    qualifiedName: d.qualifiedName ?? r.name,
    startLine: d.startLine ?? 0,
    startColumn: d.startColumn ?? 0,
  };
};

const anchoredOf = (node: ExtractNode, ordinal: number): AnchoredNode => ({
  id: node.id,
  kind: node.kind,
  name: node.name,
  qualifiedName: node.qualifiedName,
  filePath: node.filePath,
  ordinal,
});

// Step 4 for one file: reconcile the fresh nodes with the stored ones, update
// matched rows in place (only when something changed), insert new ones, and
// replace the files row and artifacts with node ids rewritten to the kept
// ones. Returns the file's nodes (final ids) and the stored nodes that are
// gone; those are deleted once every file is applied.
const applyChangedFile = (
  db: SqliteAdapter,
  f: ChangedFile,
): { nodes: ReconciledNode[]; removed: AnchoredNode[] } => {
  const storedRows = loadStoredRows(db, f.path);
  const storedById = new Map(storedRows.map((r) => [r.id, r]));
  const exists = db.prepare(`SELECT 1 AS x FROM nodes WHERE id = ?`);
  const plan = reconcileNodes(
    storedRows.map(storedNodeOf),
    f.result.nodes,
    (id) => exists.get(id) !== null,
  );

  const update = db.prepare(
    `UPDATE nodes SET type = ?, name = ?, data = ?, updated_at = ? WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  for (const { node, storedId } of plan.nodes) {
    const data = JSON.stringify(pickData(node));
    const prev = storedId ? storedById.get(storedId) : undefined;
    if (!prev) {
      insert.run(node.id, node.kind, node.name, data, now, now);
    } else if (prev.type !== node.kind || prev.name !== node.name || prev.data !== data) {
      update.run(node.kind, node.name, data, now, node.id);
    }
  }

  upsertFile(db, f.path, f.mtime, f.hash, EXTRACTOR_VERSION);
  const idOf = (id: string): string => plan.idMap.get(id) ?? id;
  replaceFileArtifacts(
    db,
    f.path,
    f.result.unresolvedReferences.map((r) => ({ ...r, fromNodeId: idOf(r.fromNodeId) })),
    f.result.edges.map((e) => ({ ...e, source: idOf(e.source), target: idOf(e.target) })),
  );
  return {
    nodes: plan.nodes,
    removed: plan.removed.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: storedById.get(r.id)!.name,
      qualifiedName: r.qualifiedName,
      filePath: f.path,
      ordinal: r.ordinal,
    })),
  };
};

// Every stored node of a file that is gone from disk.
const fileNodes = (db: SqliteAdapter, path: string): AnchoredNode[] => {
  const rows = loadStoredRows(db, path);
  const stored = rows.map(storedNodeOf);
  const ordinals = positionOrdinals(stored);
  return stored.map((s, i) => ({
    id: s.id,
    kind: s.kind,
    name: rows[i]!.name,
    qualifiedName: s.qualifiedName,
    filePath: path,
    ordinal: ordinals[i]!,
  }));
};

const deleteNodes = (db: SqliteAdapter, nodes: readonly { id: string }[]): void => {
  const del = db.prepare(`DELETE FROM nodes WHERE id = ?`);
  for (const n of nodes) del.run(n.id);
};

// Embedded nodes (extracted ones, waypoints and skills) without a current
// vector: none from the current model — left behind by an embedder failure,
// a busy write, a model switch, or a waypoint whose background embed did not
// finish — or one computed from an older version of the embedding text.
const MISSING_EMBEDDING_SQL = `FROM nodes n LEFT JOIN embeddings e ON e.node_id = n.id
  WHERE ((${EXTRACTED_NODE_SQL})
         OR n.type IN (${EMBEDDED_AGENT_KINDS.map((k) => `'${k}'`).join(', ')}))
    AND (e.node_id IS NULL OR e.model != ? OR ${STALE_EMBEDDING_SQL})`;

const nodesMissingEmbedding = (db: SqliteAdapter, model: string): EmbeddableNode[] =>
  (
    db
      .prepare(`SELECT n.id, n.type, n.name, n.data ${MISSING_EMBEDDING_SQL}`)
      .all(model) as StoredRow[]
  ).map((r) => ({
    id: r.id,
    kind: r.type,
    name: r.name,
    data: JSON.parse(r.data) as Record<string, unknown>,
  }));

const anyMissingEmbedding = (db: SqliteAdapter, model: string): boolean =>
  db.prepare(`SELECT 1 AS x ${MISSING_EMBEDDING_SQL} LIMIT 1`).get(model) !== null;

const countWalkedNodes = (db: SqliteAdapter, walked: ReadonlySet<string>): number => {
  const rows = db
    .prepare(
      `SELECT json_extract(data, '$.filePath') AS fp, COUNT(*) AS n FROM nodes
       WHERE type IN ${EXTRACTED_KINDS_SQL} GROUP BY fp`,
    )
    .all() as { fp: string | null; n: number }[];
  let n = 0;
  for (const r of rows) if (r.fp !== null && walked.has(r.fp)) n += r.n;
  return n;
};

export async function runUpdate(
  projectRoot: string,
  database: Database,
  embedder: Embedder | undefined,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  const start = Date.now();
  const db = database.adapter;
  const { mode, onProgress } = opts;

  // 1–3. Walk, classify, extract. A file is unchanged only when both its
  // content hash and the extractor version that produced its rows match.
  const known = new Map<string, { hash: string; version: number | null }>();
  for (const r of db.prepare(`SELECT path, hash, extractor_version FROM files`).all() as {
    path: string;
    hash: string;
    extractor_version: number | null;
  }[]) {
    known.set(r.path, { hash: r.hash, version: r.extractor_version });
  }
  const changed: ChangedFile[] = [];
  const seen = new Set<string>();
  for await (const file of walkProject(projectRoot, opts.walk)) {
    seen.add(file.relPath);
    onProgress?.({ phase: 'extract', current: seen.size, detail: file.relPath });
    const source = await readFile(file.absPath, 'utf-8');
    const hash = hashOf(source);
    const prev = known.get(file.relPath);
    if (!opts.force && prev?.hash === hash && prev.version === EXTRACTOR_VERSION) continue;
    const result = await extractFromSource(file.relPath, source);
    const mtime = Math.floor(statSync(file.absPath).mtimeMs);
    changed.push({ path: file.relPath, hash, mtime, result });
  }
  const inWalk = makeWalkFilter(opts.walk);
  const deleted = [...known.keys()].filter((p) => !seen.has(p) && inWalk(p));

  const nothingChanged = changed.length === 0 && deleted.length === 0;
  const healOnly = mode === 'sync' && nothingChanged;
  const markDone = (): Promise<void> =>
    retryWhenBusy(() =>
      setMeta(db, mode === 'index' ? META_LAST_INDEX_TS : META_LAST_SYNC_TS, String(Date.now())),
    );
  if (healOnly && !(embedder && anyMissingEmbedding(db, embedder.model))) {
    await markDone();
    return {
      files: seen.size,
      changed: 0,
      unchanged: seen.size,
      deleted: 0,
      nodes: countWalkedNodes(db, seen),
      edges: 0,
      unresolved: 0,
      embedded: 0,
      orphaned: 0,
      reattached: 0,
      elapsedMs: Date.now() - start,
    };
  }

  // 4–6 (+ tests edges, which derive from the rebuilt imports edges).
  const apply = db.transaction(() => {
    const changedNodes: ExtractNode[] = [];
    const written: AnchoredNode[] = [];
    const removed: (AnchoredNode & { reason: OrphanReason })[] = [];
    for (const f of changed) {
      const applied = applyChangedFile(db, f);
      for (const r of applied.nodes) {
        changedNodes.push(r.node);
        written.push(anchoredOf(r.node, r.ordinal));
      }
      for (const r of applied.removed) removed.push({ ...r, reason: 'symbol-removed' });
    }
    for (const path of deleted) {
      for (const n of fileNodes(db, path)) removed.push({ ...n, reason: 'file-deleted' });
      // Cascades the file's artifacts.
      db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
    }
    // The whole batch is snapshotted before anything is deleted, so memory
    // linking two removed nodes lands in both rows.
    const orphaned = snapshotOrphans(db, removed);
    deleteNodes(db, removed);
    const reattached = reattachOrphans(db, written);
    const stats = rebuildStructuralEdges(db, projectRoot);
    onProgress?.({ phase: 'tests-edges' });
    inferTestsEdges(db);
    return { changedNodes, stats, orphaned, reattached };
  });
  let applied = {
    changedNodes: [] as ExtractNode[],
    stats: { edges: 0, unresolved: 0 },
    orphaned: 0,
    reattached: 0,
  };
  if (!healOnly) {
    onProgress?.({ phase: 'resolve' });
    applied = await retryWhenBusy(apply);

    // 7. Hubness, lockfile enrichment, communities.
    onProgress?.({ phase: 'hubness' });
    await retryWhenBusy(() => {
      if (mode === 'index' || deleted.length > 0) {
        // Deletions can change type rosters globally; full recompute is safer.
        recomputeHubness(db);
      } else {
        recomputeHubnessForFiles(
          db,
          changed.map((f) => f.path),
        );
      }
    });
    // A2 — pull resolved versions out of lockfiles and attach to declared-deps.
    await retryWhenBusy(() => enrichDependenciesFromLockfiles(db, projectRoot));
    if (mode === 'index') {
      onProgress?.({ phase: 'communities' });
      const communityCount = await retryWhenBusy(() => detectCommunities(db));
      onProgress?.({ phase: 'communities', total: communityCount });
    }
  }
  const { changedNodes, stats, orphaned, reattached } = applied;
  // 8. The graph now matches the files.
  await markDone();

  // 9. Embed. Unchanged embedding text is skipped by text_hash, so a moved
  // symbol keeps its vector.
  let embedded = 0;
  if (embedder) {
    const candidates = new Map(changedNodes.map((n) => [n.id, embeddableOf(n)]));
    for (const n of nodesMissingEmbedding(db, embedder.model)) {
      if (!candidates.has(n.id)) candidates.set(n.id, n);
    }
    if (candidates.size > 0) {
      onProgress?.({ phase: 'embed', total: candidates.size, detail: embedder.model });
      const nodes = [...candidates.values()];
      embedded = (await retryWhenBusy(() => embedAndStore(embedder, db, nodes))).embedded;
    }
  }

  return {
    files: seen.size,
    changed: changed.length,
    unchanged: seen.size - changed.length,
    deleted: deleted.length,
    nodes: countWalkedNodes(db, seen),
    edges: stats.edges,
    unresolved: stats.unresolved,
    embedded,
    orphaned,
    reattached,
    elapsedMs: Date.now() - start,
  };
}
