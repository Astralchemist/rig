// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SqliteAdapter } from './db/adapter.ts';
import type { Database } from './db/database.ts';
import { enrichDependenciesFromLockfiles } from './db/dep-resolution.ts';
import { EXTRACTED_KINDS_SQL } from './db/extracted-nodes.ts';
import { replaceFileArtifacts } from './db/file-artifacts.ts';
import { upsertFile, upsertNode } from './db/node-queries.ts';
import { embedAndStore } from './embed/index-embeddings.ts';
import type { Embedder } from './embed/types.ts';
import { EXTRACTOR_VERSION, extractFromSource } from './extract/extractor.ts';
import type { ExtractionResult, Node as ExtractNode } from './extract/upstream-types.ts';
import { makeWalkFilter, walkProject, type WalkOptions } from './extract/walker.ts';
import { detectCommunities } from './graph/communities.ts';
import { recomputeHubness, recomputeHubnessForFiles } from './graph/hubness.ts';
import { inferTestsEdges } from './graph/tests-edges.ts';
import { rebuildStructuralEdges } from './resolve/rebuild-edges.ts';

// The one update pipeline behind `rig index`, `rig sync` and the file watcher:
//   1. walk the project
//   2. classify each file as changed, unchanged or deleted
//   3. extract changed files
//   4. write their nodes, files row and artifacts
//   5. delete the nodes and files rows of deleted files
//   6. rebuild the derived ('ast') edges from the artifacts of ALL files
//   7. embed the changed nodes
//   8. tests-edges, hubness, lockfile enrichment and communities
// Steps 4–6 and the tests edges run in one transaction, so readers never see
// a file's nodes without its edges.

export interface IndexProgress {
  phase: 'extract' | 'resolve' | 'embed' | 'tests-edges' | 'hubness' | 'communities';
  current?: number;
  total?: number;
  detail?: string;
}

export interface UpdateOptions {
  // 'index' (`rig index`, `rig start`): full hubness recompute + communities.
  // 'sync' (`rig sync`, the watcher): the cheaper incremental tail, and a
  // no-op when nothing changed.
  mode: 'index' | 'sync';
  // include/exclude globs. Only files the filtered walk could yield are
  // re-extracted or treated as deleted.
  walk?: WalkOptions | undefined;
  onProgress?: ((p: IndexProgress) => void) | undefined;
}

export interface UpdateResult {
  // Files the walk yielded.
  files: number;
  // Files (re-)extracted this run.
  changed: number;
  // Files skipped because they are unchanged.
  unchanged: number;
  // Known files gone from disk (within the walk filter), now removed.
  deleted: number;
  // Extracted nodes belonging to the walked files after the update.
  nodes: number;
  // Derived edges written by the rebuild, and unresolved refs it recorded.
  edges: number;
  unresolved: number;
  elapsedMs: number;
}

interface ChangedFile {
  path: string;
  hash: string;
  mtime: number;
  result: ExtractionResult;
}

const hashOf = (source: string): string =>
  createHash('sha256').update(source).digest('hex').slice(0, 16);

const deleteFileNodes = (db: SqliteAdapter, path: string): void => {
  db.prepare(
    `DELETE FROM nodes WHERE json_extract(data, '$.filePath') = ? AND type IN ${EXTRACTED_KINDS_SQL}`,
  ).run(path);
};

// Step 4 for one file: replace its nodes, files row and artifacts.
const applyChangedFile = (db: SqliteAdapter, f: ChangedFile): void => {
  deleteFileNodes(db, f.path);
  upsertFile(db, f.path, f.mtime, f.hash, EXTRACTOR_VERSION);
  for (const node of f.result.nodes) upsertNode(db, node);
  replaceFileArtifacts(db, f.path, f.result.unresolvedReferences, f.result.edges);
};

// Step 5 for one file. Deleting the files row cascades its artifacts.
const removeFile = (db: SqliteAdapter, path: string): void => {
  deleteFileNodes(db, path);
  db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
};

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

  // 1–3. Walk, classify, extract.
  const known = new Map<string, string>();
  for (const r of db.prepare(`SELECT path, hash FROM files`).all() as {
    path: string;
    hash: string;
  }[]) {
    known.set(r.path, r.hash);
  }
  const changed: ChangedFile[] = [];
  const seen = new Set<string>();
  for await (const file of walkProject(projectRoot, opts.walk)) {
    seen.add(file.relPath);
    const source = await readFile(file.absPath, 'utf-8');
    const hash = hashOf(source);
    if (mode === 'sync' && known.get(file.relPath) === hash) continue;
    const result = await extractFromSource(file.relPath, source);
    const mtime = Math.floor(statSync(file.absPath).mtimeMs);
    changed.push({ path: file.relPath, hash, mtime, result });
    onProgress?.({ phase: 'extract', current: seen.size, detail: file.relPath });
  }
  const inWalk = makeWalkFilter(opts.walk);
  const deleted = [...known.keys()].filter((p) => !seen.has(p) && inWalk(p));

  if (mode === 'sync' && changed.length === 0 && deleted.length === 0) {
    return {
      files: seen.size,
      changed: 0,
      unchanged: seen.size,
      deleted: 0,
      nodes: countWalkedNodes(db, seen),
      edges: 0,
      unresolved: 0,
      elapsedMs: Date.now() - start,
    };
  }

  // 4–6 (+ tests edges, which derive from the rebuilt imports edges).
  onProgress?.({ phase: 'resolve' });
  const stats = db.transaction(() => {
    for (const f of changed) applyChangedFile(db, f);
    for (const path of deleted) removeFile(db, path);
    const s = rebuildStructuralEdges(db, projectRoot);
    onProgress?.({ phase: 'tests-edges' });
    inferTestsEdges(db);
    return s;
  })();

  // 7. Embed.
  const changedNodes: ExtractNode[] = changed.flatMap((f) => f.result.nodes);
  if (embedder && changedNodes.length > 0) {
    onProgress?.({ phase: 'embed', total: changedNodes.length, detail: embedder.model });
    await embedAndStore(embedder, db, changedNodes);
  }

  // 8. Hubness, lockfile enrichment, communities.
  onProgress?.({ phase: 'hubness' });
  if (mode === 'index' || deleted.length > 0) {
    // Deletions can change type rosters globally; full recompute is safer.
    recomputeHubness(db);
  } else {
    recomputeHubnessForFiles(
      db,
      changed.map((f) => f.path),
    );
  }
  // A2 — pull resolved versions out of lockfiles and attach to declared-deps.
  enrichDependenciesFromLockfiles(db, projectRoot);
  if (mode === 'index') {
    onProgress?.({ phase: 'communities' });
    const communityCount = detectCommunities(db);
    onProgress?.({ phase: 'communities', total: communityCount });
  }

  return {
    files: seen.size,
    changed: changed.length,
    unchanged: seen.size - changed.length,
    deleted: deleted.length,
    nodes: countWalkedNodes(db, seen),
    edges: stats.edges,
    unresolved: stats.unresolved,
    elapsedMs: Date.now() - start,
  };
}
