import type { SqliteAdapter } from '../db/adapter.ts';
import { upsertEmbedding } from '../db/embed-queries.ts';
import type { Node as ExtractNode } from '../extract/upstream-types.ts';
import type { Embedder } from './types.ts';

// Concatenate the fields that make this node semantically distinct. Filter
// empty so a function with no docstring doesn't pollute the vector.
export const embeddingText = (node: ExtractNode): string => {
  const parts = [node.name, node.qualifiedName, node.signature ?? '', node.docstring ?? ''];
  return parts.filter((p) => p && p.length > 0).join('\n');
};

export interface EmbedResult {
  embedded: number;
  durationMs: number;
}

// Batch-embed and upsert. Caller is responsible for choosing which nodes to
// pass — sync passes only changed-file nodes; indexAll passes everything.
export async function embedAndStore(
  embedder: Embedder,
  adapter: SqliteAdapter,
  nodes: readonly ExtractNode[],
): Promise<EmbedResult> {
  const start = Date.now();
  if (nodes.length === 0) return { embedded: 0, durationMs: 0 };

  const texts = nodes.map(embeddingText);
  const vectors = await embedder.embed(texts);
  adapter.transaction(() => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const vector = vectors[i];
      if (vector) upsertEmbedding(adapter, node.id, embedder.model, vector);
    }
  })();
  return { embedded: nodes.length, durationMs: Date.now() - start };
}
