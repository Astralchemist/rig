import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

describe('test-to-source `tests` edges', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-tests-edge-'));
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('imports from *.test.ts are duplicated as tests edges', async () => {
    writeFileSync(join(project, 'lib.ts'), `export function widget(): void {}\n`);
    writeFileSync(
      join(project, 'lib.test.ts'),
      `import { widget } from './lib.ts';\ntest('widget', () => { widget(); });\n`,
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const tests = rig.database.adapter
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'tests'`)
      .get() as { n: number };
    expect(tests.n).toBeGreaterThan(0);
  });

  test('imports from __tests__/ produce tests edges', async () => {
    writeFileSync(join(project, 'a.ts'), `export function alpha(): void {}\n`);
    mkdirSync(join(project, '__tests__'), { recursive: true });
    writeFileSync(
      join(project, '__tests__', 'alpha.spec.ts'),
      `import { alpha } from '../a.ts';\ntest('alpha', () => alpha());\n`,
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const tests = rig.database.adapter
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'tests'`)
      .get() as { n: number };
    expect(tests.n).toBeGreaterThan(0);
  });

  test('non-test files do NOT produce tests edges', async () => {
    writeFileSync(join(project, 'a.ts'), `export function alpha(): void {}\n`);
    writeFileSync(join(project, 'b.ts'), `import { alpha } from './a.ts';\nalpha();\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    const tests = rig.database.adapter
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'tests'`)
      .get() as { n: number };
    expect(tests.n).toBe(0);
  });
});
