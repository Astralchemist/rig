// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { pathArg, resolveProjectRoot } from '../packages/mcp/src/project-root.ts';
import { mcpSession, toolResult } from './support/mcp.ts';

const GENERATED = resolve(__dirname, '../generated/installer');

describe('--path parsing', () => {
  const cwd = resolve('/work/cwd');
  const quiet = () => {};

  test('absent → cwd', () => {
    expect(pathArg(['--mcp'])).toBeNull();
    expect(resolveProjectRoot(['--mcp'], cwd, quiet)).toBe(cwd);
  });

  test('`--path <dir>` and `--path=<dir>`, relative to cwd', () => {
    expect(resolveProjectRoot(['--mcp', '--path', '/repo/a'], cwd, quiet)).toBe(resolve('/repo/a'));
    expect(resolveProjectRoot(['--path=../b', '--mcp'], cwd, quiet)).toBe(resolve(cwd, '../b'));
  });

  test('an unexpanded or missing value falls back to cwd with a warning', () => {
    for (const argv of [['--mcp', '--path', '${workspaceFolder}'], ['--mcp', '--path'], ['--path', '--mcp']]) {
      const warnings: string[] = [];
      expect(resolveProjectRoot(argv, cwd, (m) => warnings.push(m))).toBe(cwd);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe('rig serve --mcp --path', () => {
  let base: string;
  let home: string;
  let project: string;
  let elsewhere: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'rig-serve-path-'));
    home = join(base, 'home');
    project = join(base, 'project');
    elsewhere = join(base, 'elsewhere');
    for (const d of [home, project, elsewhere]) mkdirSync(d, { recursive: true });
    const rig = await Rig.init(project);
    rig.close();
    writeFileSync(join(project, '.rig', 'config.json'), JSON.stringify({ embedder: { kind: 'deterministic' } }));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const statusVia = async (pathArgs: string[]) => {
    const run = await mcpSession(['serve', '--mcp', ...pathArgs], { cwd: elsewhere, home }, [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'test' } } },
      { id: 2, method: 'tools/call', params: { name: 'rig_status', arguments: {} } },
    ]);
    return { run, status: toolResult(run.byId['2']) };
  };

  test('serves the --path project, not the cwd it was launched from', async () => {
    const { run, status } = await statusVia(['--path', project]);
    expect(run.byId['1']?.result).toBeDefined();
    expect(status?.initialized).toBe(true);
  });

  test('--path=<dir> works too', async () => {
    const { status } = await statusVia([`--path=${project}`]);
    expect(status?.initialized).toBe(true);
  });
});

describe('Cursor passes --path ${workspaceFolder}', () => {
  test('in both the project and the user-level mcp.json', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rig-cursor-path-'));
    try {
      const opts = { rigBin: 'rig', generatedDir: GENERATED, home: join(base, 'home'), projectRoot: join(base, 'p') };
      await installTarget(getTarget('cursor')!, { ...opts, scope: 'project' });
      await installTarget(getTarget('cursor')!, { ...opts, scope: 'global' });
      for (const f of [join(base, 'p', '.cursor/mcp.json'), join(base, 'home', '.cursor/mcp.json')]) {
        const args = JSON.parse(readFileSync(f, 'utf-8')).mcpServers.rig.args;
        expect(args).toEqual(['serve', '--mcp', '--path', '${workspaceFolder}']);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
