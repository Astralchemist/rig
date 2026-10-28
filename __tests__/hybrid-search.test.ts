// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, Rig, type SqliteAdapter } from '@rig/core';
import { upsertEmbedding } from '@rig/core/db/embed-queries.ts';
import { VectorIndex } from '@rig/core/search/vector-index.ts';
import { ControlledEmbedder, writeFixture } from './_search-fixture.ts';

const insertNode = (
  db: SqliteAdapter,
  id: string,
  type: string,
  name: string,
  data: object,
): void => {
  db.prepare(
    `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`,
  ).run(id, type, name, JSON.stringify(data));
};

describe('vector index', () => {
  let dir: string;
  let db: Database;
  // Rows the index read back from the embeddings table.
  let rowsRead = 0;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-vec-'));
    db = Database.open(join(dir, 'rig.db'));
    rowsRead = 0;
    const real = db.adapter;
    adapter = {
      ...real,
      open: true,
      prepare: (sql: string) => {
        const st = real.prepare(sql);
        if (!/FROM embeddings e JOIN nodes/.test(sql)) return st;
        return {
          ...st,
          all: (...p: unknown[]) => {
            const rows = st.all(...p);
            rowsRead += rows.length;
            return rows;
          },
        };
      },
    } as SqliteAdapter;
    insertNode(real, 'a', 'function', 'a', { filePath: 'a.ts' });
    insertNode(real, 'b', 'class', 'b', { filePath: 'b.ts' });
    insertNode(real, 's', 'skill', 's', {});
    upsertEmbedding(real, 'a', 'm', new Float32Array([1, 0, 0]));
    upsertEmbedding(real, 'b', 'm', new Float32Array([0.9, 0.1, 0]));
    upsertEmbedding(real, 's', 'm', new Float32Array([0.8, 0, 0.2]));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('cosine top-k, with kind and source filters', () => {
    const ix = new VectorIndex(adapter, 'm');
    ix.refresh();
    const q = new Float32Array([2, 0, 0]);
    expect(ix.search(q, { k: 2 }).map((h) => h.id)).toEqual(['a', 'b']);
    expect(ix.search(q, { k: 5, kinds: ['class'] }).map((h) => h.id)).toEqual(['b']);
    expect(ix.search(q, { k: 5, sourceOnly: true }).map((h) => h.id)).toEqual(['a', 'b']);
    expect(ix.search(q, { k: 1 })[0]!.score).toBeCloseTo(1, 6);
    // Below the similarity floor is no match.
    expect(ix.search(new Float32Array([0, -1, 0]), { k: 5 })).toEqual([]);
  });

  test('loads once, then reads only rows written since', () => {
    const ix = new VectorIndex(adapter, 'm');
    ix.refresh();
    expect(rowsRead).toBe(3);
    ix.refresh();
    expect(rowsRead).toBe(3);
    insertNode(db.adapter, 'c', 'function', 'c', {});
    upsertEmbedding(db.adapter, 'c', 'm', new Float32Array([0, 0, 1]));
    ix.refresh();
    expect(rowsRead).toBe(4);
    expect(ix.search(new Float32Array([0, 0, 1]), { k: 1 })[0]!.id).toBe('c');
    // Re-embedding a node replaces its vector in place.
    upsertEmbedding(db.adapter, 'c', 'm', new Float32Array([0, 1, 0]));
    ix.refresh();
    expect(rowsRead).toBe(5);
    expect(ix.size).toBe(4);
    expect(ix.search(new Float32Array([0, 1, 0]), { k: 1 })[0]!.id).toBe('c');
  });

  test('a deleted node triggers a full reload; other models are ignored', () => {
    const ix = new VectorIndex(adapter, 'm');
    ix.refresh();
    db.adapter.prepare(`DELETE FROM nodes WHERE id = 'a'`).run();
    insertNode(db.adapter, 'o', 'function', 'o', {});
    upsertEmbedding(db.adapter, 'o', 'other-model', new Float32Array([1, 0, 0]));
    ix.refresh();
    expect(ix.size).toBe(2);
    expect(ix.search(new Float32Array([1, 0, 0]), { k: 5 }).map((h) => h.id)).toEqual(['b', 's']);
  });
});

describe('hybrid search on the fixture', () => {
  let project: string;
  let rig: Rig;
  let embedder: ControlledEmbedder;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-hybrid-'));
    writeFixture(project);
    embedder = new ControlledEmbedder();
    rig = await Rig.init(project, { embedder });
    await rig.indexAll();
  });
  afterAll(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });
  afterEach(() => {
    embedder.unblock();
  });

  test('vector matches come back with score and matched_by', async () => {
    const r = await rig.search('make thumbnails smaller', { limit: 5 });
    expect(r.degraded).toBeUndefined();
    const hit = r.hits.find((h) => h.node.name === 'shrinkImage')!;
    expect(hit.matchedBy).toEqual(['vector']);
    expect(hit.score).toBeGreaterThan(0);
    expect(r.hits.map((h) => h.score)).toEqual(
      [...r.hits.map((h) => h.score)].sort((a, b) => b - a),
    );
  });

  test('the kind filter holds for every list', async () => {
    const r = await rig.search('refresh expired sessions', { kinds: ['class'], limit: 10 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.node.type === 'class')).toBe(true);
  });

  test('query vectors are cached', async () => {
    await rig.search('purge old items from memory');
    const calls = embedder.calls;
    await rig.search('purge old items from memory');
    expect(embedder.calls).toBe(calls);
  });

  test('a model still loading answers keyword-only within the wait budget', async () => {
    embedder.mode = 'hang';
    const t0 = Date.now();
    const r = await rig.search('where is configuration loaded (slow)', { waitMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.degraded).toBe('keyword-only');
    // Loading carried on; once done, the same query has its vector.
    embedder.unblock();
    await new Promise((r) => setTimeout(r, 0));
    const again = await rig.search('where is configuration loaded (slow)', { waitMs: 50 });
    expect(again.degraded).toBeUndefined();
    expect(again.hits.map((h) => h.node.name)).toContain('readSettings');
  });

  test('a model that fails to load degrades to keyword-only and never throws', async () => {
    // Runs after the other searches here: a failure pauses the model for a minute.
    embedder.mode = 'fail';
    const r = await rig.search('compress old logs! (unique query)', { limit: 5 });
    expect(r.degraded).toBe('keyword-only');
    expect(r.hits.map((h) => h.node.name)).toContain('rotateLogs');
    expect(r.hits.every((h) => !h.matchedBy.includes('vector'))).toBe(true);
    // Exact names still come first.
    expect((await rig.search('LruCache')).hits[0]!.node.name).toBe('LruCache');
  });

  test('no embedder at all is keyword-only', async () => {
    const bare = new Rig({
      projectRoot: project,
      database: Database.open(join(project, '.rig', 'rig.db')),
    });
    const r = await bare.search('TokenBucket');
    expect(r.degraded).toBe('keyword-only');
    expect(r.hits[0]!.node.name).toBe('TokenBucket');
    expect(r.hits[0]!.matchedBy).toEqual(['name', 'keyword']);
    bare.close();
  });
});
