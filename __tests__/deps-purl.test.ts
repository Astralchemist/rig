// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { packageOfImport, pinnedVersion, purlOf } from '@rig/core/db/dep-edges.ts';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

describe('purl', () => {
  test('npm: the scope is the namespace, its @ encoded', () => {
    expect(purlOf('npm', 'lodash', '4.17.21')).toBe('pkg:npm/lodash@4.17.21');
    expect(purlOf('npm', '@types/node', '20.11.5')).toBe('pkg:npm/%40types/node@20.11.5');
    expect(purlOf('npm', 'react')).toBe('pkg:npm/react');
  });

  test('pypi: lowercase, underscores become dashes', () => {
    expect(purlOf('pypi', 'Typing_Extensions', '4.9.0')).toBe('pkg:pypi/typing-extensions@4.9.0');
    expect(purlOf('cargo', 'serde')).toBeNull();
  });

  test('only exact pins give a version', () => {
    expect(pinnedVersion('npm', '1.2.3')).toBe('1.2.3');
    expect(pinnedVersion('npm', '=1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(pinnedVersion('npm', '^1.2.3')).toBeNull();
    expect(pinnedVersion('npm', 'latest')).toBeNull();
    expect(pinnedVersion('pypi', '==2.1.4')).toBe('2.1.4');
    expect(pinnedVersion('pypi', '>=2.1')).toBeNull();
  });

  test('the package an import names', () => {
    expect(packageOfImport('lodash/get', 'a.ts')).toBe('lodash');
    expect(packageOfImport('@scope/pkg/sub', 'a.ts')).toBe('@scope/pkg');
    expect(packageOfImport('./x', 'a.ts')).toBeNull();
    expect(packageOfImport('node:fs', 'a.ts')).toBeNull();
    expect(packageOfImport('pandas.io.sql', 'a.py')).toBe('pandas');
  });
});

describe('dependency edges in a Bun workspace', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-purl-'));
    mkdirSync(join(project, 'packages/web/src'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        workspaces: ['packages/*'],
        dependencies: {
          zod: '^3.23',
          lodash: '4.17.21',
          chalk: '^5',
          ms: '^2',
          web: 'workspace:*',
        },
      }),
    );
    writeFileSync(
      join(project, 'packages/web/package.json'),
      JSON.stringify({ name: 'web', dependencies: { zod: '^3.22', '@types/react': '^18' } }),
    );
    // bun.lock is JSONC: trailing commas are allowed.
    writeFileSync(
      join(project, 'bun.lock'),
      `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "root" }, "packages/web": { "name": "web" } },
  "packages": {
    "zod": ["zod@3.23.8", "", {}, "sha512-x"],
    "@types/react": ["@types/react@18.3.3", "", {}, "sha512-y"],
    "web": ["web@workspace:packages/web"],
    "web/zod": ["zod@3.22.4", "", {}, "sha512-z"],
  },
}
`,
    );
    writeFileSync(
      join(project, 'src/a.ts'),
      "import { z } from 'zod';\nimport get from 'lodash/get';\nexport const a = z;\n",
    );
    writeFileSync(
      join(project, 'src/lazy.ts'),
      "export const c = async () => (await import('chalk')).default;\nconst ms = require('ms');\nconst n = 'x';\nexport const d = () => import(`./${n}`);\n",
    );
    writeFileSync(
      join(project, 'packages/web/src/b.ts'),
      "import { z } from 'zod';\nimport type { FC } from '@types/react';\nexport const b = z;\n",
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const dep = (manifest: string, name: string) =>
    rig.getDependencies(manifest).find((d) => d.name === name)!;

  test('versions come from the root bun.lock; nested installs are skipped', () => {
    expect(dep('package.json', 'zod').resolved_version).toBe('3.23.8');
    expect(dep('package.json', 'zod').purl).toBe('pkg:npm/zod@3.23.8');
    expect(dep('packages/web/package.json', '@types/react').purl).toBe(
      'pkg:npm/%40types/react@18.3.3',
    );
  });

  test('an exact pin gives the version when no lockfile entry does', () => {
    expect(dep('package.json', 'lodash').purl).toBe('pkg:npm/lodash@4.17.21');
  });

  test('imports resolve to the nearest manifest that declares the package', () => {
    expect(dep('package.json', 'zod').used_by).toBe(1);
    expect(dep('packages/web/package.json', 'zod').used_by).toBe(1);
    expect(dep('package.json', 'lodash').used_by).toBe(1);
    expect(dep('packages/web/package.json', '@types/react').used_by).toBe(1);
  });

  test('literal dynamic imports and requires count as uses', () => {
    expect(dep('package.json', 'chalk').used_by).toBe(1);
    expect(dep('package.json', 'ms').used_by).toBe(1);
  });

  test('a workspace dependency is not a registry package, so it has no purl', () => {
    expect(dep('package.json', 'web').purl).toBeNull();
    expect(purlOf('npm', 'x', null, 'file:../x')).toBeNull();
  });

  test('re-indexing rebuilds the edges instead of adding to them', async () => {
    await rig.indexAll({ force: true });
    expect(dep('package.json', 'zod').used_by).toBe(1);
  });
});
