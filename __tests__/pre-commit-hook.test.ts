// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const INSTALLER = 'scripts/install-hooks.sh';

// Git exports these to hooks; never let them aim the commands below elsewhere.
const baseEnv: Record<string, string | undefined> = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete baseEnv[k];

const git = (cwd: string, args: string[], env = baseEnv): string => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// Ask git where hooks live rather than assuming .git/hooks: in a linked
// worktree .git is a file and hooks sit in the main checkout's git dir.
const hooksDir = (cwd: string, env = baseEnv): string =>
  git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], env);

const HOOK = join(hooksDir(ROOT), 'pre-commit');

describe('pre-commit hook (Phase 1.5 §9 acceptance)', () => {
  test('hook is installed in the git hooks dir', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  test('hook is executable', () => {
    const mode = statSync(HOOK).mode & 0o777;
    // Owner exec bit must be set (0o100).
    expect(mode & 0o100).toBe(0o100);
  });

  test('hook runs `bun run gen:check`', () => {
    const body = readFileSync(HOOK, 'utf-8');
    expect(body).toContain('gen:check');
  });

  test('install:hooks run from a linked worktree installs into the shared hooks dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rig-hooks-'));
    // A throwaway repo, isolated from global/system git config so a
    // developer's core.hooksPath or signing setup can't leak in.
    const env = {
      ...baseEnv,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'rig',
      GIT_AUTHOR_EMAIL: 'rig@example.invalid',
      GIT_COMMITTER_NAME: 'rig',
      GIT_COMMITTER_EMAIL: 'rig@example.invalid',
    };
    try {
      const repo = join(tmp, 'main');
      const worktree = join(tmp, 'worktree');
      git(tmp, ['init', '-q', repo], env);
      git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'], env);
      git(repo, ['worktree', 'add', '-q', '--detach', worktree], env);
      // Run the installer from <worktree>/scripts/, as `bun run install:hooks` would.
      mkdirSync(join(worktree, 'scripts'));
      copyFileSync(join(ROOT, INSTALLER), join(worktree, INSTALLER));
      const r = spawnSync('bash', [join(worktree, INSTALLER)], { env });
      expect(r.status).toBe(0);

      const hook = join(hooksDir(worktree, env), 'pre-commit');
      expect(hook).toBe(join(hooksDir(repo, env), 'pre-commit'));
      expect(statSync(hook).mode & 0o100).toBe(0o100);
      expect(readFileSync(hook, 'utf-8')).toContain('gen:check');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
