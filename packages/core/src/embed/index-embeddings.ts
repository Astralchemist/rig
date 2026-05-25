// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { SqliteAdapter } from '../db/adapter.ts';
import { getEmbeddingFingerprint, upsertEmbedding } from '../db/embed-queries.ts';
import type { Node as ExtractNode } from '../extract/upstream-types.ts';
import type { Embedder } from './types.ts';

// Concatenate the fields that make this node semantically distinct. Filter
// empty so a function with no docstring doesn't pollute the vector.
export const embeddingText = (node: ExtractNode): string => {
  const parts = [node.name, node.qualifiedName, node.signature ?? '', node.docstring ?? ''];
  return parts.filter((p) => p && p.length > 0).join('\n');
};

const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface EmbedResult {
  embedded: number;
  skipped: number;
  durationMs: number;
}

// Batch-embed and upsert. Skips nodes whose embedding text hash matches the
// existing row (same model + same content) — re-running `rig index --force`
// on an unchanged repo now becomes O(0) instead of O(N) on the bge inference.
export async function embedAndStore(
  embedder: Embedder,
  adapter: SqliteAdapter,
  nodes: readonly ExtractNode[],
): Promise<EmbedResult> {
  const start = Date.now();
  if (nodes.length === 0) return { embedded: 0, skipped: 0, durationMs: 0 };

  const texts = nodes.map(embeddingText);
  const hashes = texts.map(hashOf);

  const toEmbed: { node: ExtractNode; text: string; hash: string; idx: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const fp = getEmbeddingFingerprint(adapter, node.id);
    if (fp && fp.model === embedder.model && fp.text_hash === hashes[i]) continue;
    toEmbed.push({ node, text: texts[i]!, hash: hashes[i]!, idx: i });
  }

  if (toEmbed.length === 0) {
    return { embedded: 0, skipped: nodes.length, durationMs: Date.now() - start };
  }

  const vectors = await embedder.embed(toEmbed.map((e) => e.text));
  adapter.transaction(() => {
    for (let i = 0; i < toEmbed.length; i++) {
      const { node, hash } = toEmbed[i]!;
      const vector = vectors[i];
      if (vector) upsertEmbedding(adapter, node.id, embedder.model, vector, hash);
    }
  })();
  return {
    embedded: toEmbed.length,
    skipped: nodes.length - toEmbed.length,
    durationMs: Date.now() - start,
  };
}
