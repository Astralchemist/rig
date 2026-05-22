import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './types.ts';

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DIM = 384;

/**
 * Lazy-loads @xenova/transformers and caches the model under ~/.cache/rig/models.
 * First call downloads ~90 MB; subsequent calls reuse the cache.
 */
export class LocalEmbedder implements Embedder {
  readonly model = MODEL_ID;
  readonly dim = DIM;
  private pipelinePromise: Promise<(text: string, opts: object) => Promise<{ data: Float32Array }>> | null = null;

  private async pipe(): Promise<(text: string, opts: object) => Promise<{ data: Float32Array }>> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      const mod = (await import('@xenova/transformers')) as {
        env: { cacheDir: string; allowLocalModels?: boolean };
        pipeline: (task: string, model: string) => Promise<unknown>;
      };
      mod.env.cacheDir = join(homedir(), '.cache', 'rig', 'models');
      const p = (await mod.pipeline('feature-extraction', MODEL_ID)) as (
        text: string,
        opts: object,
      ) => Promise<{ data: Float32Array }>;
      return p;
    })();
    return this.pipelinePromise;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const p = await this.pipe();
    const out: Float32Array[] = [];
    for (const t of texts) {
      const r = await p(t, { pooling: 'mean', normalize: true });
      out.push(new Float32Array(r.data));
    }
    return out;
  }
}
