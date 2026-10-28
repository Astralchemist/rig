// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { wireDetectedAgents } from '../packages/cli/src/install/wire.ts';
import { runCli } from './support/cli.ts';

// Issue #1: OpenRouter is an OpenAI-compatible API, not an MCP host.
describe('openrouter target', () => {
  let base: string;
  let home: string;
  let project: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-openrouter-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    rmSync(base, { recursive: true, force: true });
  });

  test('is never auto-detected, even with OPENROUTER_API_KEY set', async () => {
    expect(await getTarget('openrouter')!.detect()).toBe(false);
  });

  test('so `rig start` never wires it', async () => {
    const report = await wireDetectedAgents({
      rigBin: 'rig',
      generatedDir: resolve(__dirname, '../generated/installer'),
      projectRoot: project,
      home,
      // real detection for openrouter; every other agent absent
      detect: (t) => (t.name === 'openrouter' ? t.detect() : Promise.resolve(false)),
    });
    expect(report.wired).toEqual([]);
    expect(report.userLevelOnly).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test('`rig install openrouter` says it writes a reference config', () => {
    const r = runCli(['install', 'openrouter'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('~/.config/openrouter/mcp.json');
    expect(r.stdout).toContain('~/.config/openrouter/AGENTS.md');
    expect(r.stdout.match(/note: reference only — OpenRouter is an API, not an MCP host/g)).toHaveLength(2);
    expect(r.stdout).toContain('Copy its mcpServers.rig entry into the MCP client');
    expect(existsSync(join(home, '.config/openrouter/mcp.json'))).toBe(true);
  });
});
