// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverContracts } from '../scripts/gen/discover.ts';
import { assertContiguousMigrations, assertUniqueByName, buildFiles } from '../scripts/gen.ts';
import type { LoadedContract } from '../scripts/gen/types.ts';

const ROOT = resolve(__dirname, '..');

// Run gen-check via spawn so we exercise the exit-code surface the pre-commit
// hook depends on (not just the in-process buildFiles path).
const runGenCheck = (): { code: number; stderr: string } => {
  const r = spawnSync('bun', ['run', 'gen:check'], { cwd: ROOT, encoding: 'utf-8' });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
};

describe('phase1.5 contracts — validation', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'rig-contracts-'));
  });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test('malformed contract surfaces file + path in error', async () => {
    const dir = join(workspace, 'bad-tool', '.contracts', 'tools');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rig_broken.contract.ts'),
      `export default { name: 'rig_broken' };\n`,
    );
    await expect(discoverContracts(join(workspace, 'bad-tool'))).rejects.toThrow(
      /rig_broken\.contract\.ts.*contract validation failed/s,
    );
  });

  test('missing default export rejected with filename', async () => {
    const dir = join(workspace, 'no-default', '.contracts', 'tools');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rig_none.contract.ts'), `export const x = 1;\n`);
    await expect(discoverContracts(join(workspace, 'no-default'))).rejects.toThrow(
      /rig_none\.contract\.ts.*missing default export/,
    );
  });
});

describe('phase1.5 contracts — cross-validation', () => {
  // These call the exported assertion helpers directly to avoid having to write
  // synthetic .contract.ts files into a temp dir (which can't resolve zod).
  const mkMigration = (version: number): LoadedContract<'migrations'> =>
    ({
      kind: 'migrations',
      file: `.contracts/migrations/v${version}.contract.ts`,
      absFile: '',
      basename: `v${version}`,
      data: {
        version,
        description: 'test',
        applied_in_phase: 1,
        forward: 'SELECT 1;',
        rollback: 'SELECT 1;',
      },
    }) as unknown as LoadedContract<'migrations'>;

  const mkTool = (name: string): LoadedContract<'tools'> =>
    ({
      kind: 'tools',
      file: `.contracts/tools/${name}.contract.ts`,
      absFile: '',
      basename: name,
      data: { name },
    }) as unknown as LoadedContract<'tools'>;

  test('non-contiguous migrations rejected (v1+v3 without v2)', () => {
    expect(() => assertContiguousMigrations([mkMigration(1), mkMigration(3)])).toThrow(
      /contiguous from 1/,
    );
  });

  test('contiguous migrations pass', () => {
    expect(() =>
      assertContiguousMigrations([mkMigration(1), mkMigration(2)]),
    ).not.toThrow();
  });

  test('duplicate tool names rejected with both file paths', () => {
    expect(() =>
      assertUniqueByName(
        [mkTool('rig_dupe'), mkTool('rig_dupe')],
        'tool',
        (c) => c.data.name,
      ),
    ).toThrow(/Duplicate tool 'rig_dupe'/);
  });
});

describe('phase1.5 contracts — freshness', () => {
  test('gen:check exits 0 when generated/ is fresh', () => {
    const r = runGenCheck();
    expect(r.code).toBe(0);
  });

  test('gen:check exits non-zero when manifest is stale', () => {
    const manifestPath = join(ROOT, 'generated', '.manifest');
    const original = readFileSync(manifestPath, 'utf-8');
    try {
      // Corrupt one hash so the manifest diverges from the regenerated set.
      const tampered = original.replace(/"[a-f0-9]{16}"/, '"0000000000000000"');
      writeFileSync(manifestPath, tampered);
      const r = runGenCheck();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/stale/i);
    } finally {
      writeFileSync(manifestPath, original);
    }
  });
});

describe('phase1.5 contracts — perf', () => {
  test('buildFiles completes under 3s on the real contract set', async () => {
    const start = Date.now();
    const { files } = await buildFiles();
    const elapsed = Date.now() - start;
    expect(files.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(3000);
  });
});
