import { createHash } from 'node:crypto';
import type { Embedder } from './types.ts';

const DIM = 384;

/**
 * Stable hash-based embedder for tests. Same text → same vector. Cosine
 * similarity between unrelated texts is near zero, between identical texts
 * is 1.0. No network, no model files.
 */
export class DeterministicEmbedder implements Embedder {
  readonly model = 'rig-deterministic-sha256-384';
  readonly dim = DIM;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => embedOne(t));
  }
}

function embedOne(text: string): Float32Array {
  const v = new Float32Array(DIM);
  // Mix DIM/32 = 12 SHA-256 digests by salting the text differently each round.
  for (let round = 0; round < DIM / 32; round++) {
    const digest = createHash('sha256').update(`${round}:${text}`).digest();
    for (let i = 0; i < 32; i++) {
      v[round * 32 + i] = (digest[i]! - 128) / 128; // map 0..255 → -1..~1
    }
  }
  // L2 normalize so cosine sim ∈ [-1, 1].
  let sumsq = 0;
  for (let i = 0; i < DIM; i++) sumsq += v[i]! * v[i]!;
  const inv = 1 / Math.sqrt(sumsq);
  for (let i = 0; i < DIM; i++) v[i] = v[i]! * inv;
  return v;
}
