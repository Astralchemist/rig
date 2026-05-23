import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Database } from './db/database.ts';
import { upsertFile, upsertNode } from './db/node-queries.ts';
import { embedAndStore } from './embed/index-embeddings.ts';
import type { Embedder } from './embed/types.ts';
import { extractFromSource } from './extract/extractor.ts';
import type { Node as ExtractNode } from './extract/upstream-types.ts';
import { walkProject } from './extract/walker.ts';
import { recomputeHubness } from './graph/hubness.ts';

export interface SyncResult {
  filesChanged: number;
  filesPurged: number;
  durationMs: number;
}

/**
 * Incremental sync: walk the project, re-extract files whose content hash has
 * changed, and purge nodes/file rows for paths that disappeared since the last
 * index. Edge cascades (edges, edges_semantic, embeddings) and the nodes_fts
 * trigger handle their own cleanup via ON DELETE CASCADE.
 */
export async function runSync(
  projectRoot: string,
  database: Database,
  embedder?: Embedder,
): Promise<SyncResult> {
  const start = Date.now();
  let filesChanged = 0;
  let filesPurged = 0;

  const known = new Map<string, string>();
  const knownRows = database.adapter
    .prepare(`SELECT path, hash FROM files`)
    .all() as { path: string; hash: string }[];
  for (const r of knownRows) known.set(r.path, r.hash);

  const changedNodes: ExtractNode[] = [];
  const seen = new Set<string>();
  for await (const file of walkProject(projectRoot)) {
    seen.add(file.relPath);
    const source = await readFile(file.absPath, 'utf-8');
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    if (known.get(file.relPath) === hash) continue;
    const mtime = statSync(file.absPath).mtimeMs;
    const result = await extractFromSource(file.relPath, source);
    database.adapter.transaction(() => {
      upsertFile(database.adapter, file.relPath, Math.floor(mtime), hash);
      for (const node of result.nodes) upsertNode(database.adapter, node);
    })();
    changedNodes.push(...result.nodes);
    filesChanged++;
  }

  if (embedder && changedNodes.length > 0) {
    await embedAndStore(embedder, database.adapter, changedNodes);
  }

  const adapter = database.adapter;
  const purgeNodes = adapter.prepare(
    `DELETE FROM nodes WHERE json_extract(data, '$.filePath') = ?`,
  );
  const purgeFile = adapter.prepare(`DELETE FROM files WHERE path = ?`);
  for (const knownPath of known.keys()) {
    if (seen.has(knownPath)) continue;
    adapter.transaction(() => {
      purgeNodes.run(knownPath);
      purgeFile.run(knownPath);
    })();
    filesPurged++;
  }

  if (filesChanged > 0 || filesPurged > 0) {
    recomputeHubness(database.adapter);
  }
  return { filesChanged, filesPurged, durationMs: Date.now() - start };
}
