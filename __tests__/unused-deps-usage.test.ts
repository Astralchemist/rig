// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Uses that aren't imports (scripts/deps-eval found most "unused" flags were
// these): commands, config files, @types pairs, workspace packages, peers.
describe('rig_unused_deps counts uses that are not imports', () => {
  let project: string;
  let rig: Rig;
  const w = (p: string, s: string) => {
    mkdirSync(join(project, p, '..'), { recursive: true });
    writeFileSync(join(project, p), s);
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-usage-'));
    w(
      'package.json',
      JSON.stringify({
        name: 'root',
        scripts: { typecheck: 'tsc --noEmit', fmt: 'prettier --write .' },
        devDependencies: {
          typescript: '^5',
          prettier: '^3',
          '@types/node': '^20',
          '@types/express': '^4',
          'eslint-plugin-promise': '^6',
          vitest: '^3',
          '@vitest/ui': '^3',
          'never-used': '^1',
          '@types/left-pad': '^1',
        },
        dependencies: { express: '^4', 'wasm-pack': '1.0.0', web: 'workspace:*' },
      }),
    );
    w('.eslintrc.json', JSON.stringify({ plugins: ['promise'] }));
    w('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npx vitest --ui\n');
    w(
      'src/a.ts',
      "import express from 'express';\nconst p = require.resolve('wasm-pack/out/x.wasm');\nexport const a = [express, p];\n",
    );
    w(
      'packages/web/package.json',
      JSON.stringify({
        name: 'web',
        dependencies: { next: '^15', 'react-dom': '^19', react: '^19' },
      }),
    );
    w('packages/web/src/page.ts', 'export const page = 1;\n');
    w('src/b.ts', "import { page } from '../packages/web/src/page.ts';\nexport const b = page;\n");
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const flagged = () => new Set(rig.getUnusedDependencies().map((d) => d.name));

  test('commands in package.json scripts and CI count, under the bin name too', () => {
    const f = flagged();
    expect(f.has('typescript')).toBe(false);
    expect(f.has('prettier')).toBe(false);
    expect(f.has('vitest')).toBe(false);
    expect(f.has('@vitest/ui')).toBe(false);
  });

  test('config files count: eslint plugins by their short name', () => {
    expect(flagged().has('eslint-plugin-promise')).toBe(false);
  });

  test('@types pairs and runtime types count; @types for nothing used does not', () => {
    const f = flagged();
    expect(f.has('@types/node')).toBe(false);
    expect(f.has('@types/express')).toBe(false);
    expect(f.has('@types/left-pad')).toBe(true);
  });

  test('require.resolve counts as a use', () => {
    expect(flagged().has('wasm-pack')).toBe(false);
  });

  test('a workspace package imported by path counts; framework peers count', () => {
    const f = flagged();
    expect(f.has('web')).toBe(false);
    expect(f.has('react-dom')).toBe(false);
  });

  test('a dependency nothing mentions is still flagged', () => {
    expect(flagged().has('never-used')).toBe(true);
  });
});
