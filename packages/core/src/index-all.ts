import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Database } from './db/database.ts';
import { purgeFileNodes, upsertFile, upsertNode } from './db/node-queries.ts';
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
import { detectCommunities } from './graph/communities.ts';
import { recomputeHubness } from './graph/hubness.ts';
import { inferTestsEdges } from './graph/tests-edges.ts';
import type { IndexResult } from './rig-types.ts';

export interface IndexProgress {
  phase: 'extract' | 'resolve' | 'embed' | 'tests-edges' | 'hubness' | 'communities';
  current?: number;
  total?: number;
  detail?: string;
}

export async function runIndexAll(
  projectRoot: string,
  database: Database,
  embedder?: Embedder,
  onProgress?: (p: IndexProgress) => void,
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
      purgeFileNodes(database.adapter, file.relPath);
      upsertFile(database.adapter, file.relPath, Math.floor(mtime), hash);
      for (const node of result.nodes) upsertNode(database.adapter, node);
    })();
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    allRefs.push(...result.unresolvedReferences);
    fileCount++;
    onProgress?.({ phase: 'extract', current: fileCount, detail: file.relPath });
  }
  onProgress?.({ phase: 'resolve', total: allRefs.length });
  const stats = database.adapter.transaction(() =>
    resolveReferences(database.adapter, allNodes, allRefs, allEdges, projectRoot),
  )();
  if (embedder) {
    onProgress?.({ phase: 'embed', total: allNodes.length, detail: embedder.model });
    await embedAndStore(embedder, database.adapter, allNodes);
  }
  onProgress?.({ phase: 'tests-edges' });
  inferTestsEdges(database.adapter);
  onProgress?.({ phase: 'hubness' });
  recomputeHubness(database.adapter);
  onProgress?.({ phase: 'communities' });
  const communityCount = detectCommunities(database.adapter);
  onProgress?.({ phase: 'communities', total: communityCount });
  return {
    files: fileCount,
    nodes: allNodes.length,
    edges: stats.edges,
    unresolved: stats.unresolved,
    elapsed_ms: Date.now() - start,
  };
}
