// SPDX-License-Identifier: Apache-2.0

// Reciprocal rank fusion. Each candidate list ranks node ids by its own
// measure (bm25, cosine, exact-name quality); a node scores
// Σ weight / (k + rank) over the lists it appears in (rank from 1), so
// agreement between lists counts and no list's raw scores need calibrating
// against another's.

export type MatchSource = 'name' | 'alias' | 'keyword' | 'vector';

// Order of `matched_by`, whatever order the lists are fused in.
export const MATCH_SOURCES: readonly MatchSource[] = ['name', 'alias', 'keyword', 'vector'];

export const RRF_K = 60;

// Exact name and alias matches are weighted so they always come first: the
// lists are capped at EXACT_LIST_CAP, and EXACT_WEIGHT / (k + cap) still beats
// the best a node can get from the other two lists (rank 1 in both,
// 2 / (k + 1)).
export const EXACT_LIST_CAP = 50;
export const EXACT_WEIGHT = 4;

export interface RankedList {
  source: MatchSource;
  ids: readonly string[];
  weight?: number;
}

export interface Fused {
  id: string;
  score: number;
  matchedBy: MatchSource[];
}

export const fuseRrf = (lists: readonly RankedList[], k = RRF_K): Fused[] => {
  const acc = new Map<string, { score: number; sources: Set<MatchSource>; first: number }>();
  let seen = 0;
  for (const list of lists) {
    const w = list.weight ?? 1;
    list.ids.forEach((id, i) => {
      let e = acc.get(id);
      if (!e) {
        e = { score: 0, sources: new Set(), first: seen++ };
        acc.set(id, e);
      }
      // A list naming an id twice counts it once, at its best rank.
      if (e.sources.has(list.source)) return;
      e.sources.add(list.source);
      e.score += w / (k + i + 1);
    });
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first)
    .map(([id, e]) => ({
      id,
      score: e.score,
      matchedBy: MATCH_SOURCES.filter((s) => e.sources.has(s)),
    }));
};
