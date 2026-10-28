// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';
import {
  exactAndKeywordLists,
  loadRanked,
  poolSize,
  type CandidateFilter,
} from '../db/search-queries.ts';
import type { Embedder } from '../embed/types.ts';
import { logDebug } from '../errors.ts';
import type { Node } from '../extract/upstream-types.ts';
import { fuseRrf, type MatchSource, type RankedList } from './fuse.ts';
import { QueryEmbedder } from './query-embedder.ts';
import { VectorIndex } from './vector-index.ts';

export interface HybridSearchOptions extends CandidateFilter {
  limit?: number | undefined;
  // How long a query waits for the embedding model to load before answering
  // without vectors. Default: DEFAULT_WAIT_MS.
  waitMs?: number | undefined;
}

export interface HybridHit {
  node: Node;
  // Fused RRF score; higher is better. Only comparable within one search.
  score: number;
  // The candidate lists the node came from.
  matchedBy: MatchSource[];
}

export interface HybridResult {
  hits: HybridHit[];
  // Set when the vector list was left out: no embedder, the model could not
  // load (in time), or nothing is embedded with the current model yet.
  degraded?: 'keyword-only';
}

export const DEFAULT_WAIT_MS = 3000;

// Hybrid search: exact name and alias matches, bm25 keyword hits and cosine
// nearest neighbours of the embedded query, fused by reciprocal rank (fuse.ts).
// The vector side is best effort; without it the other lists still answer.
export class HybridSearcher {
  private readonly index: VectorIndex | null;
  private readonly queries: QueryEmbedder | null;

  constructor(
    private readonly db: SqliteAdapter,
    embedder: Embedder | undefined,
  ) {
    this.index = embedder ? new VectorIndex(db, embedder.model) : null;
    this.queries = embedder ? new QueryEmbedder(embedder) : null;
  }

  async search(query: string, opts: HybridSearchOptions = {}): Promise<HybridResult> {
    const limit = opts.limit ?? 20;
    if (!query.trim()) return { hits: [] };
    const filter: CandidateFilter = { kinds: opts.kinds, sourceOnly: opts.sourceOnly };
    const lists: RankedList[] = exactAndKeywordLists(this.db, query, filter, limit);
    const vector = await this.vectorList(query, filter, limit, opts.waitMs ?? DEFAULT_WAIT_MS);
    if (vector) lists.push({ source: 'vector', ids: vector });
    const hits = loadRanked(this.db, fuseRrf(lists), filter, limit);
    return vector ? { hits } : { hits, degraded: 'keyword-only' };
  }

  // null when the vector side is unavailable (as opposed to [] for no hits).
  private async vectorList(
    query: string,
    filter: CandidateFilter,
    limit: number,
    waitMs: number,
  ): Promise<string[] | null> {
    if (!this.index || !this.queries) return null;
    try {
      this.index.refresh();
      if (this.index.size === 0) return null;
      const q = await this.queries.embed(query.trim(), waitMs);
      if (!q || !this.db.open) return null;
      return this.index
        .search(q, { k: poolSize(limit), kinds: filter.kinds, sourceOnly: filter.sourceOnly })
        .map((h) => h.id);
    } catch (e) {
      logDebug('Vector search failed; searching without vectors', { error: String(e) });
      return null;
    }
  }

  // Pick up vectors written since the last search (after a sync or a
  // background embed), so the next query doesn't pay for it. Only once the
  // index has been loaded by a search or warm().
  refreshIndex(): void {
    if (!this.index?.loaded || !this.db.open) return;
    try {
      this.index.refresh();
    } catch (e) {
      logDebug('Vector index refresh failed', { error: String(e) });
    }
  }

  // Load the vectors and the model in the background.
  warm(): void {
    if (!this.index || !this.queries) return;
    try {
      this.index.refresh();
    } catch (e) {
      logDebug('Vector index load failed', { error: String(e) });
    }
    this.queries.warm();
  }
}
