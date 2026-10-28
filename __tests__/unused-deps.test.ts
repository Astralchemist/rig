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

// Python `import x` / `import x as y` must count as uses, not just `from x import y`.
describe('A2 rig_unused_deps — Python imports', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-unused-py-'));
    writeFileSync(
      join(project, 'requirements.txt'),
      [
        'pandas==2.1.4',
        'numpy>=1.26',
        'matplotlib',
        'scipy',
        'requests',
        'PyYAML',
        'Flask',
        'typing-extensions',
        'protobuf',
        'Pillow',
        '',
      ].join('\n'),
    );
    writeFileSync(join(project, 'pyproject.toml'), '[project]\ndependencies = ["pandas>=2.1"]\n');
    writeFileSync(
      join(project, 'main.py'),
      [
        'import numpy',
        'import pandas as pd',
        'import matplotlib.pyplot as plt',
        'from scipy.stats import norm',
        'import yaml',
        'from flask import Flask',
        'from typing_extensions import Literal',
        'from google.protobuf import json_format',
        'from PIL import Image',
        '',
        'def load(path):',
        '    return pd.read_csv(path)',
        '',
      ].join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('an aliased import counts as a use (import pandas as pd)', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.filter((d) => d.name === 'pandas')).toEqual([]);
  });

  test('a plain import counts as a use (import numpy)', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.find((d) => d.name === 'numpy')).toBeUndefined();
  });

  test('dotted imports count toward the top-level package', () => {
    const names = rig.getUnusedDependencies().map((d) => d.name);
    expect(names).not.toContain('matplotlib');
    expect(names).not.toContain('scipy');
  });

  test('a distribution counts as used under its import name (PyYAML → import yaml)', () => {
    const names = rig.getUnusedDependencies().map((d) => d.name);
    expect(names).not.toContain('PyYAML');
    expect(names).not.toContain('Pillow'); // from PIL import …
    expect(names).not.toContain('protobuf'); // from google.protobuf import …
  });

  test('distribution names match imports per PEP 503 (Flask → flask)', () => {
    const names = rig.getUnusedDependencies().map((d) => d.name);
    expect(names).not.toContain('Flask');
    expect(names).not.toContain('typing-extensions'); // typing_extensions
  });

  test('a declared package that is never imported is still flagged', () => {
    const unused = rig.getUnusedDependencies();
    expect(unused.map((d) => d.name)).toEqual(['requests']);
  });
});
