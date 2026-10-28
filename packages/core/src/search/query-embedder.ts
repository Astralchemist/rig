// SPDX-License-Identifier: Apache-2.0
import { logDebug } from '../errors.ts';
import type { Embedder } from '../embed/types.ts';

export interface QueryEmbedderOptions {
  // Query vectors kept, least recently used dropped first.
  cacheSize?: number;
  // After a failure (the model can't load: offline first run, missing
  // files), queries skip the embedder for this long before trying again.
  retryAfterMs?: number;
}

// Embeds search queries with the project's embedder. The model loads lazily on
// the first query (or warm()); a query waits for it at most `waitMs` and is
// answered without vectors after that, while loading carries on for the next
// one. Never throws: no vector is the answer to every failure.
export class QueryEmbedder {
  private readonly cache = new Map<string, Float32Array>();
  private readonly cacheSize: number;
  private readonly retryAfterMs: number;
  private failedAt = 0;

  constructor(
    private readonly embedder: Embedder,
    opts: QueryEmbedderOptions = {},
  ) {
    this.cacheSize = opts.cacheSize ?? 64;
    this.retryAfterMs = opts.retryAfterMs ?? 60_000;
  }

  get model(): string {
    return this.embedder.model;
  }

  async embed(text: string, waitMs: number): Promise<Float32Array | null> {
    const hit = this.cache.get(text);
    if (hit) {
      this.cache.delete(text);
      this.cache.set(text, hit);
      return hit;
    }
    if (this.failedAt && Date.now() - this.failedAt < this.retryAfterMs) return null;
    const work = this.run(text);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Load the model in the background so the first query doesn't wait for it.
  warm(): void {
    void this.run('warm up');
  }

  private async run(text: string): Promise<Float32Array | null> {
    try {
      const v = this.embedder.embedQuery
        ? await this.embedder.embedQuery(text)
        : (await this.embedder.embed([text]))[0];
      if (!v || v.length !== this.embedder.dim) throw new Error('embedder returned no vector');
      this.failedAt = 0;
      this.cache.set(text, v);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      return v;
    } catch (e) {
      this.failedAt = Date.now();
      logDebug('Query embedding failed; searching without vectors', { error: String(e) });
      return null;
    }
  }
}
