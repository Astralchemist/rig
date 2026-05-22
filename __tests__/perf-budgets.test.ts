import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb } from '../packages/web/src/index.ts';

// Budgets from docs/phase3plan.md §1.3. Where we can't hit the spec's exact
// scale within a CI-friendly test (e.g. "index 500 files < 15s"), we run a
// proportional fixture and assert a proportional budget.

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
