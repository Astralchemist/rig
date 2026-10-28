// SPDX-License-Identifier: Apache-2.0
// Run the rig CLI from source in a child process with an isolated HOME, so
// installer commands can never touch the real user's agent config.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CLI = resolve(__dirname, '../../packages/cli/src/index.ts');

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// Bun keeps its transpiler cache under HOME by default; point it elsewhere so
// a test HOME only ever contains what rig itself wrote.
export const cliEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  NO_COLOR: '1',
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'rig-test-bun-cache'),
});

export const runCli = (args: string[], opts: { cwd: string; home: string }): CliRun => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    env: cliEnv(opts.home),
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
