// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { upsertEmbedding } from '../packages/core/src/db/embed-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { serveWeb } from '../packages/web/src/index.ts';

// Performance budgets. Where we can't hit the target scale within a
// CI-friendly test (e.g. "index 500 files < 15s"), we run a proportional
// fixture and assert a proportional budget.

describe('performance budgets (§1.3)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-perf-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('rig init cold start < 500ms', async () => {
    const start = Date.now();
    const rig = await Rig.init(project);
    const elapsed = Date.now() - start;
    rig.close();
    expect(elapsed).toBeLessThan(500);
  });

  test('rig status cold start < 200ms (after init)', async () => {
    const rig = await Rig.init(project);
    const start = Date.now();
    await rig.status();
    const elapsed = Date.now() - start;
    rig.close();
    expect(elapsed).toBeLessThan(200);
  });

  test('index 100 files in < 5s (scales to 500 < 15s)', async () => {
    for (let i = 0; i < 100; i++) {
      writeFileSync(
        join(project, `f${i}.ts`),
        `export function thing${i}(arg: string): number { return arg.length + ${i}; }`,
      );
    }
    const rig = await Rig.init(project);
    const start = Date.now();
    const result = await rig.indexAll();
    const elapsed = Date.now() - start;
    rig.close();
    expect(result.files).toBe(100);
    expect(elapsed).toBeLessThan(5000);
  });

  test('rig_search < 50ms on a small index', async () => {
    for (let i = 0; i < 50; i++) {
      writeFileSync(
        join(project, `f${i}.ts`),
        `export class Widget${i} { do(): void {} }`,
      );
    }
    const rig = await Rig.init(project);
    await rig.indexAll();
    const start = Date.now();
    const hits = rig.searchNodes('Widget7');
    const elapsed = Date.now() - start;
    rig.close();
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  test('rig_pull < 100ms on a small index', async () => {
    for (let i = 0; i < 30; i++) {
      writeFileSync(
        join(project, `f${i}.ts`),
        `export function fn${i}(): void {}`,
      );
    }
    const rig = await Rig.init(project);
    await rig.indexAll();
    const anchor = rig.searchNodes('fn0')[0];
    expect(anchor).toBeDefined();
    const start = Date.now();
    const pulls = rig.getMagneticPull(anchor!.id, 10);
    const elapsed = Date.now() - start;
    rig.close();
    expect(pulls.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });

  // Hybrid search scans every vector of the model, so it is budgeted at the
  // size of a large repo: 20k nodes with 384-d embeddings, written straight
  // into the graph. The embedder is the deterministic one, so the timing is
  // rig's own work (FTS, cosine scan, fusion, row loads) once a model is up.
  test('hybrid search < 100ms on a 20k-node graph (model loaded)', async () => {
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    const db = rig.database.adapter;
    const N = 20_000;
    const DIM = 384;
    let seed = 42;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const words = ['session', 'token', 'cache', 'invoice', 'retry', 'login', 'render', 'parse'];
    const insert = db.prepare(
      `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`,
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const w = words[i % words.length]!;
        const name = `${w}Handler${i}`;
        insert.run(
          `n${i}`,
          i % 5 === 0 ? 'class' : 'function',
          name,
          JSON.stringify({
            qualifiedName: `mod${i % 300}.${name}`,
            filePath: `src/mod${i % 300}.ts`,
            docstring: `Handles the ${w} step ${i}`,
          }),
        );
        const v = new Float32Array(DIM);
        for (let d = 0; d < DIM; d++) v[d] = rand();
        upsertEmbedding(db, `n${i}`, 'rig-deterministic-sha256-384', v);
      }
    })();
    // First search loads the vectors and the (deterministic) model.
    await rig.search('warm up the index');
    const queries = [
      'where do we refresh expired sessions?',
      'sessionHandler42',
      'fix the login bug',
    ];
    let worst = 0;
    for (const q of queries) {
      const start = performance.now();
      const r = await rig.search(q, { limit: 20 });
      worst = Math.max(worst, performance.now() - start);
      expect(r.degraded).toBeUndefined();
      expect(r.hits.length).toBeGreaterThan(0);
    }
    rig.close();
    expect(worst).toBeLessThan(100);
  }, 60_000);

  test('web server cold start < 1s', async () => {
    const rig = await Rig.init(project);
    rig.close();
    const start = Date.now();
    const handle = await serveWeb({ projectRoot: project, port: 0 });
    const elapsed = Date.now() - start;
    void handle.close();
    expect(elapsed).toBeLessThan(1000);
  });
});
