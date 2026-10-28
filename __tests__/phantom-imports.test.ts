// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// A2 follow-up — bare imports that don't match any declared dep.
describe('A2 rig_phantom_imports', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-phantom-'));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '4.0.0' },
      }),
    );
    writeFileSync(
      join(project, 'a.ts'),
      [
        // declared → not a phantom
        `import _ from 'lodash';`,
        // not declared → phantom
        `import np from 'numpy-typo';`,
        // subpath of declared → not a phantom
        `import get from 'lodash/get';`,
        // relative — never a phantom regardless
        `import { x } from './local';`,
        'export function f(): void { _(); np(); get({}); }',
      ].join('\n'),
    );
    writeFileSync(join(project, 'local.ts'), 'export const x = 1;\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('flags imports that have no matching declared dep', () => {
    const ph = rig.getPhantomImports();
    const names = ph.map((p) => p.target_name);
    expect(names).toContain('numpy-typo');
  });

  test('does not flag imports of declared deps', () => {
    const ph = rig.getPhantomImports();
    expect(ph.find((p) => p.target_name === 'lodash')).toBeUndefined();
  });

  test('subpath of a declared dep is not a phantom', () => {
    const ph = rig.getPhantomImports();
    expect(ph.find((p) => p.target_name === 'lodash/get')).toBeUndefined();
  });

  test('relative imports are never phantoms', () => {
    const ph = rig.getPhantomImports();
    expect(ph.find((p) => p.target_name.startsWith('.'))).toBeUndefined();
  });
});

// Python refs are dotted module paths; they normalize to the top-level package.
describe('A2 rig_phantom_imports — Python', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-phantom-py-'));
    writeFileSync(join(project, 'requirements.txt'), 'matplotlib\n');
    writeFileSync(
      join(project, 'main.py'),
      ['import matplotlib.pyplot as plt', 'import yamll.loader', 'from .helpers import tidy', ''].join('\n'),
    );
    writeFileSync(join(project, 'helpers.py'), 'def tidy():\n    pass\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('a dotted import of a declared package is not a phantom', () => {
    const ph = rig.getPhantomImports();
    expect(ph.find((p) => p.target_name === 'matplotlib.pyplot')).toBeUndefined();
  });

  test('a dotted import of an undeclared package is a phantom', () => {
    const ph = rig.getPhantomImports();
    expect(ph.map((p) => p.target_name)).toContain('yamll.loader');
  });

  test('relative imports are never phantoms', () => {
    const ph = rig.getPhantomImports();
    expect(ph.find((p) => p.target_name.startsWith('.'))).toBeUndefined();
  });
});
