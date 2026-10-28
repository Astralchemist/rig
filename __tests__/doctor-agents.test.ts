// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { wiredLocations } from '../packages/cli/src/install/uninstall.ts';
import { runCli } from './support/cli.ts';

const GENERATED = resolve(__dirname, '../generated/installer');

// `rig doctor` must see rig wherever install put it — the project's config by
// default, or the user-level one with --global.
describe('rig doctor — agent wiring', () => {
  let base: string;
  let home: string;
  let project: string;
  const agentLine = (out: string) => out.split('\n').find((l) => l.includes('agent: Claude Code')) ?? '';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-doctor-agents-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{}\n'); // Claude Code is installed
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const wire = (name: string, scope: 'project' | 'global') =>
    installTarget(getTarget(name)!, { rigBin: 'rig', generatedDir: GENERATED, home, projectRoot: project, scope });

  test('finds the project-scoped .mcp.json', async () => {
    await wire('claude', 'project');
    expect(agentLine(runCli(['doctor'], { cwd: project, home }).stdout)).toMatch(/✓ agent: Claude Code\s+rig wired in \.mcp\.json$/);
  });

  test('finds the user-level ~/.claude.json', async () => {
    await wire('claude', 'global');
    expect(agentLine(runCli(['doctor'], { cwd: project, home }).stdout)).toMatch(/✓ agent: Claude Code\s+rig wired in ~\/\.claude\.json$/);
  });

  test('flags an installed agent rig is not wired into', () => {
    const out = runCli(['doctor'], { cwd: project, home }).stdout;
    expect(agentLine(out)).toMatch(/✗ agent: Claude Code\s+installed, but rig is not wired/);
    expect(out).toContain('hint: run `rig install claude`');
  });

  test('wiredLocations reads every config format', async () => {
    for (const name of ['claude', 'cursor']) await wire(name, 'project');
    for (const name of ['codex', 'opencode']) await wire(name, 'global');
    const where = (name: string) => wiredLocations(getTarget(name)!, project, home).map((w) => w.scope);
    expect(where('claude')).toEqual(['project']);
    expect(where('cursor')).toEqual(['project']);
    expect(where('codex')).toEqual(['global']);
    expect(where('opencode')).toEqual(['global']);
    expect(where('openrouter')).toEqual([]);
  });
});
