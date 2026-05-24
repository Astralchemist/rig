import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 — package-lock.json resolution enriches declared-deps with installed versions.
describe('A2 lockfile resolution', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-lock-'));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '^4.17.0', pandas: '*' },
        devDependencies: { '@types/node': '^20.0.0' },
      }),
    );
    writeFileSync(
      join(project, 'package-lock.json'),
      JSON.stringify({
        name: 'demo',
        lockfileVersion: 3,
        packages: {
          '': { name: 'demo', dependencies: { lodash: '^4.17.0' } },
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/@types/node': { version: '20.11.5' },
          // Nested install — should be ignored
          'node_modules/foo/node_modules/lodash': { version: '3.0.0' },
        },
      }),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('top-level installs land on declared-deps as resolved_version', () => {
    const deps = rig.getDependencies('package.json');
    const byName = new Map(deps.map((d) => [d.name, d]));
    expect(byName.get('lodash')!.resolved_version).toBe('4.17.21');
    expect(byName.get('@types/node')!.resolved_version).toBe('20.11.5');
  });

  test('declared-but-not-installed deps have resolved_version=null', () => {
    const deps = rig.getDependencies('package.json');
    const pandas = deps.find((d) => d.name === 'pandas')!;
    expect(pandas.resolved_version).toBeNull();
  });

  test('nested node_modules installs do not leak as resolutions', () => {
    const deps = rig.getDependencies('package.json');
    const lodash = deps.find((d) => d.name === 'lodash')!;
    // The nested 3.0.0 should NOT win — top-level 4.17.21 should
    expect(lodash.resolved_version).not.toBe('3.0.0');
  });
});
