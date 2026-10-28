// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { buildFiles } from '../scripts/gen.ts';
import { REPO_CURSOR_RULE } from '../scripts/gen/repo-files.ts';

const ROOT = resolve(__dirname, '..');

// The repo's own Cursor rule is generator output, not a hand-kept copy.
describe('repo .cursor/rules/rig.mdc', () => {
  const committed = readFileSync(join(ROOT, REPO_CURSOR_RULE), 'utf-8');

  test('matches what `bun run gen` renders (run it if this fails)', async () => {
    const { repoFiles } = await buildFiles();
    expect(committed).toBe(repoFiles.find((f) => f.path === REPO_CURSOR_RULE)!.content);
  });

  test('is byte-identical to what `rig install cursor` writes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rig-repo-rule-'));
    try {
      await installTarget(getTarget('cursor')!, {
        rigBin: 'rig',
        generatedDir: join(ROOT, 'generated/installer'),
        home: join(base, 'home'),
        projectRoot: base,
        scope: 'project',
      });
      expect(readFileSync(join(base, REPO_CURSOR_RULE), 'utf-8')).toBe(committed);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
