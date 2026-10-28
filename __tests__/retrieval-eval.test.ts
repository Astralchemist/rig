// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig, type SqliteAdapter } from '@rig/core';
import { LocalEmbedder } from '@rig/core/embed/local-embedder.ts';
import {
  ConceptEmbedder,
  IDENTIFIER_QUERIES,
  NL_QUERIES,
  writeFixture,
} from './_search-fixture.ts';

// Retrieval eval: natural-language questions with known answers over a small
// repo (_search-fixture.ts). A hit is an expected anchor in the top 5.

const K = 5;

// Search as it was up to 0.2.0: every word a quoted prefix that must match
// (AND) in name or qualified_name, unioned with alias FTS, best bm25 first.
const legacySearch = (db: SqliteAdapter, query: string, limit: number): string[] => {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
  if (!terms) return [];
  try {
    return (
      db
        .prepare(
          `SELECT name, MIN(rank) AS rank FROM (
             SELECT n.id, n.name, bm25(nodes_fts) AS rank
             FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
             WHERE nodes_fts MATCH ?
             UNION ALL
             SELECT n.id, n.name, bm25(aliases_fts) AS rank
             FROM aliases_fts JOIN nodes n ON n.id = aliases_fts.node_id
             WHERE aliases_fts MATCH ?
           ) GROUP BY id ORDER BY rank LIMIT ?`,
        )
        .all(`{name qualified_name} : (${terms})`, terms, limit) as { name: string }[]
    ).map((r) => r.name);
  } catch {
    return [];
  }
};

const hitRate = async (search: (q: string) => Promise<string[]> | string[]): Promise<number> => {
  let hits = 0;
  for (const { query, expect: want } of NL_QUERIES) {
    const top = (await search(query)).slice(0, K);
    if (top.some((name) => want.includes(name))) hits++;
  }
  return hits / NL_QUERIES.length;
};

const evalRig = (makeEmbedder: () => ConceptEmbedder | LocalEmbedder) => {
  const state: { rig?: Rig; project?: string } = {};
  beforeAll(async () => {
    state.project = mkdtempSync(join(tmpdir(), 'rig-eval-'));
    writeFixture(state.project);
    state.rig = await Rig.init(state.project, { embedder: makeEmbedder() });
    await state.rig.indexAll();
  });
  afterAll(() => {
    state.rig?.close();
    if (state.project) rmSync(state.project, { recursive: true, force: true });
  });
  return state;
};

describe('retrieval eval (concept embedder)', () => {
  const s = evalRig(() => new ConceptEmbedder());

  test('natural-language hit@5: ~0 with the old search, ≥ 80% with hybrid', async () => {
    const rig = s.rig!;
    const legacy = await hitRate((q) => legacySearch(rig.database.adapter, q, K));
    const keyword = await hitRate((q) => rig.searchNodes(q, { limit: K }).map((n) => n.name));
    const hybrid = await hitRate(async (q) =>
      (await rig.search(q, { limit: K })).hits.map((h) => h.node.name),
    );
    expect(legacy).toBeLessThanOrEqual(0.1);
    // The keyword side alone (v14 columns, OR semantics) already finds some.
    expect(keyword).toBeGreaterThan(legacy);
    expect(hybrid).toBeGreaterThanOrEqual(0.8);
  });

  test('identifier queries still put the named symbol first', async () => {
    for (const { query, expect: name } of IDENTIFIER_QUERIES) {
      const { hits, degraded } = await s.rig!.search(query, { limit: 10 });
      expect(degraded).toBeUndefined();
      expect(hits[0]?.node.name).toBe(name);
      expect(s.rig!.searchNodes(query, { limit: 10 })[0]?.name).toBe(name);
    }
  });

  test('anchor discovery for a plain-language task returns source anchors', async () => {
    const { hits } = await s.rig!.search('fix the login bug', { limit: 5, sourceOnly: true });
    expect(hits.map((h) => h.node.name)).toContain('authenticateUser');
    expect(hits.every((h) => typeof h.node.data.filePath === 'string')).toBe(true);
    // The old search found nothing to anchor on.
    expect(legacySearch(s.rig!.database.adapter, 'fix the login bug', 5)).toEqual([]);
  });
});

// The same eval against the real local model, when it is already cached (it
// is never downloaded for a test run).
const BGE_CACHED = existsSync(
  join(homedir(), '.cache', 'rig', 'models', 'Xenova', 'bge-small-en-v1.5', 'onnx'),
);

describe.skipIf(!BGE_CACHED)('retrieval eval (bge-small, cached model only)', () => {
  const s = evalRig(() => new LocalEmbedder());

  test('natural-language hit@5 ≥ 80% with hybrid; identifiers first', async () => {
    const rig = s.rig!;
    const hybrid = await hitRate(async (q) =>
      (await rig.search(q, { limit: K, waitMs: 60_000 })).hits.map((h) => h.node.name),
    );
    expect(hybrid).toBeGreaterThanOrEqual(0.8);
    for (const { query, expect: name } of IDENTIFIER_QUERIES) {
      expect((await rig.search(query, { limit: 10 })).hits[0]?.node.name).toBe(name);
    }
  }, 120_000);
});
