// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './types.ts';

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
const BATCH_SIZE = 32;

interface TransformersTensor {
  data: Float32Array;
  dims: number[];
}
type FeaturePipeline = (
  input: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<TransformersTensor>;

/**
 * Lazy-loads @xenova/transformers and caches the model under ~/.cache/rig/models.
 * First call downloads ~90 MB; subsequent calls reuse the cache. Embeds in
 * mini-batches of BATCH_SIZE for 5–10× throughput vs. one-at-a-time.
 */
export class LocalEmbedder implements Embedder {
  readonly model = MODEL_ID;
  readonly dim = DIM;
  private pipelinePromise: Promise<FeaturePipeline> | null = null;

  private async pipe(): Promise<FeaturePipeline> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      const mod = (await import('@xenova/transformers')) as {
        env: { cacheDir: string; allowLocalModels?: boolean };
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      mod.env.cacheDir = join(homedir(), '.cache', 'rig', 'models');
      return (await mod.pipeline('feature-extraction', MODEL_ID)) as FeaturePipeline;
    })();
    return this.pipelinePromise;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const p = await this.pipe();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const tensor = await p(batch as string[], { pooling: 'mean', normalize: true });
      // Tensor shape is [batchSize, DIM] flattened into a single Float32Array.
      for (let j = 0; j < batch.length; j++) {
        const slice = new Float32Array(DIM);
        slice.set(tensor.data.subarray(j * DIM, (j + 1) * DIM));
        out.push(slice);
      }
    }
    return out;
  }
}
