// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 follow-up — heuristic detection of declared-but-never-imported deps.
describe('A2 rig_unused_deps', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-unused-'));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        dependencies: {
          'used-pkg': '1.0.0',
          'unused-pkg': '1.0.0',
          'lodash': '4.0.0',
          '@types/node': '20.0.0',
        },
      }),
    );
    writeFileSync(
      join(project, 'a.ts'),
      [
        `import { something } from 'used-pkg';`,
        // subpath — should count as a use of lodash
        `import get from 'lodash/get';`,
        // scoped — should count as a use of @types/node
        `import type { Foo } from '@types/node/path';`,
        'export function f(): void { something(); get({}); }',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('flags declared-but-never-imported package', () => {
    const unused = rig.getUnusedDependencies();
    const names = unused.map((d) => d.name);
    expect(names).toContain('unused-pkg');
  });

  test('does not flag deps with bare imports', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.find((d) => d.name === 'used-pkg')).toBeUndefined();
  });

  test('subpath imports count toward the parent package', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.find((d) => d.name === 'lodash')).toBeUndefined();
  });

  test('scoped subpath imports count toward the scoped package', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.find((d) => d.name === '@types/node')).toBeUndefined();
  });
});
