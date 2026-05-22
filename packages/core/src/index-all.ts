import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Database } from './db/database.ts';
import { upsertFile, upsertNode } from './db/node-queries.ts';
import { embedAndStore } from './embed/index-embeddings.ts';
import type { Embedder } from './embed/types.ts';
import { extractFromSource } from './extract/extractor.ts';
import type {
  Edge as ExtractEdge,
  Node as ExtractNode,
  UnresolvedReference,
} from './extract/upstream-types.ts';
import { walkProject } from './extract/walker.ts';
import { resolveReferences } from './resolve/resolver.ts';
import type { IndexResult } from './rig-types.ts';

export async function runIndexAll(
  projectRoot: string,
  database: Database,
  embedder?: Embedder,
): Promise<IndexResult> {
  const start = Date.now();
  const allNodes: ExtractNode[] = [];
  const allEdges: ExtractEdge[] = [];
  const allRefs: UnresolvedReference[] = [];
  let fileCount = 0;
  for await (const file of walkProject(projectRoot)) {
    const source = await readFile(file.absPath, 'utf-8');
    const mtime = statSync(file.absPath).mtimeMs;
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const result = await extractFromSource(file.relPath, source);
    database.adapter.transaction(() => {
      upsertFile(database.adapter, file.relPath, Math.floor(mtime), hash);
      for (const node of result.nodes) upsertNode(database.adapter, node);
    })();
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    allRefs.push(...result.unresolvedReferences);
    fileCount++;
  }
  const stats = database.adapter.transaction(() =>
    resolveReferences(database.adapter, allNodes, allRefs, allEdges),
  )();
  if (embedder) {
    await embedAndStore(embedder, database.adapter, allNodes);
  }
  return {
    files: fileCount,
    nodes: allNodes.length,
    edges: stats.edges,
    unresolved: stats.unresolved,
    elapsed_ms: Date.now() - start,
  };
}
