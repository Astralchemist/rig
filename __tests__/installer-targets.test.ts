// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import type { Scope } from '../packages/cli/src/install/paths.ts';
import { hasScope, installTarget } from '../packages/cli/src/install/runner.ts';

const GENERATED = resolve(__dirname, '../generated/installer');

// Every test gets its own HOME and project dir; `home` and `projectRoot` are
// passed explicitly because Bun's os.homedir() ignores runtime HOME changes.
describe('installer targets', () => {
  let HOME: string;
  let PROJECT: string;

  const installOpts = (scope: Scope) => ({
    rigBin: 'rig',
    generatedDir: GENERATED,
    home: HOME,
    projectRoot: PROJECT,
    scope,
  });
  const json = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'rig-installer-'));
    HOME = join(base, 'home');
    PROJECT = join(base, 'project');
    mkdirSync(HOME, { recursive: true });
    mkdirSync(PROJECT, { recursive: true });
  });

  afterEach(() => rmSync(resolve(HOME, '..'), { recursive: true, force: true }));

  test('claude defaults to project scope: .mcp.json, .claude/settings.json, CLAUDE.md', async () => {
    const result = await installTarget(getTarget('claude')!, installOpts('project'));
    expect(result.scope).toBe('project');
    expect(result.applied.map((a) => a.path)).toEqual([
      join(PROJECT, '.mcp.json'),
      join(PROJECT, '.claude/settings.json'),
      join(PROJECT, '.claude/settings.json'),
      join(PROJECT, 'CLAUDE.md'),
    ]);
    expect(result.applied.map((a) => a.role)).toEqual([
      'mcp_config',
      'permissions',
      'hooks',
      'instructions',
    ]);
    expect(result.applied.every((a) => a.changed)).toBe(true);

    // The documented .mcp.json stdio entry: command + args, no `type`.
    expect(json(join(PROJECT, '.mcp.json'))).toEqual({
      mcpServers: { rig: { command: 'rig', args: ['serve', '--mcp'] } },
    });

    const settings = json(join(PROJECT, '.claude/settings.json'));
    expect(settings.permissions.allow).toContain('mcp__rig__rig_status');
    expect(settings.permissions.ask).toContain('mcp__rig__rig_explore');
    expect(settings.permissions.ask).toContain('mcp__rig__rig_context');

    const md = readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8');
    expect(md.startsWith('<!-- rig:begin -->')).toBe(true);
    expect(md).toContain('rig_status');

    // Nothing user-level was touched.
    expect(readdirSync(HOME)).toEqual([]);
  });

  test('the .mcp.json note tells the user Claude Code will ask to approve the server', async () => {
    const result = await installTarget(getTarget('claude')!, installOpts('project'));
    expect(result.applied[0]!.note).toMatch(/approve/);
  });

  test('claude project install appends to an existing CLAUDE.md', async () => {
    writeFileSync(join(PROJECT, 'CLAUDE.md'), '# My project\n\nUse pnpm.\n');
    await installTarget(getTarget('claude')!, installOpts('project'));
    const md = readFileSync(join(PROJECT, 'CLAUDE.md'), 'utf-8');
    expect(md.startsWith('# My project\n\nUse pnpm.\n')).toBe(true);
    expect(md).toContain('<!-- rig:begin -->');
    expect(md.trimEnd().endsWith('<!-- rig:end -->')).toBe(true);
  });

  test('claude --global writes the user-level files and nothing in the project', async () => {
    const result = await installTarget(getTarget('claude')!, installOpts('global'));
    expect(result.applied.map((a) => a.path)).toEqual([
      join(HOME, '.claude.json'),
      join(HOME, '.claude/settings.json'),
      join(HOME, '.claude/CLAUDE.md'),
    ]);
    const claudeJson = json(join(HOME, '.claude.json'));
    expect(claudeJson.mcpServers.rig).toEqual({ type: 'stdio', command: 'rig', args: ['serve', '--mcp'] });
    expect(json(join(HOME, '.claude/settings.json')).permissions.allow).toContain('mcp__rig__rig_status');
    expect(readFileSync(join(HOME, '.claude/CLAUDE.md'), 'utf-8')).toContain('<!-- rig:begin -->');
    expect(readdirSync(PROJECT)).toEqual([]);
  });

  test('claude install is idempotent on a second run (both scopes)', async () => {
    for (const scope of ['project', 'global'] as const) {
      await installTarget(getTarget('claude')!, installOpts(scope));
      const second = await installTarget(getTarget('claude')!, installOpts(scope));
      expect(second.applied.every((a) => !a.changed)).toBe(true);
    }
  });

  test('cursor project scope writes .cursor/mcp.json, cli.json + rig.mdc with frontmatter', async () => {
    const result = await installTarget(getTarget('cursor')!, installOpts('project'));
    expect(result.applied.map((a) => a.path)).toEqual([
      join(PROJECT, '.cursor/mcp.json'),
      join(PROJECT, '.cursor/cli.json'),
      join(PROJECT, '.cursor/rules/rig.mdc'),
    ]);
    const mcp = json(join(PROJECT, '.cursor/mcp.json'));
    expect(mcp.mcpServers.rig.args).toContain('--path');
    const mdc = readFileSync(join(PROJECT, '.cursor/rules/rig.mdc'), 'utf-8');
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc).toContain('alwaysApply: true');
    expect(readdirSync(HOME)).toEqual([]);
  });

  test('cursor --global writes only ~/.cursor/mcp.json', async () => {
    const result = await installTarget(getTarget('cursor')!, installOpts('global'));
    expect(result.applied.map((a) => a.path)).toEqual([join(HOME, '.cursor/mcp.json')]);
    expect(result.applied[0]!.note).toMatch(/per project/);
    expect(readdirSync(PROJECT)).toEqual([]);
  });

  test('codex and opencode only have user-level config', () => {
    for (const name of ['codex', 'opencode']) {
      expect(hasScope(getTarget(name)!, 'project')).toBe(false);
      expect(hasScope(getTarget(name)!, 'global')).toBe(true);
    }
  });

  test('codex writes [mcp_servers.rig] + per-tool approval tables preserving sibling tables', async () => {
    // Pre-seed file with a sibling table that must survive the install.
    const codexDir = join(HOME, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), '[model]\nname = "gpt-4"\n');
    await installTarget(getTarget('codex')!, installOpts('global'));
    const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.rig]');
    expect(toml).toContain('command = "rig"');
    expect(toml).toContain('[model]');
    expect(toml).toContain('name = "gpt-4"');
    expect(toml).toContain('[mcp_servers.rig.tools.rig_status]\napproval_mode = "approve"');
    expect(toml).toContain('[mcp_servers.rig.tools.rig_explore]\napproval_mode = "prompt"');
  });

  test('opencode merge-jsonc preserves user comments', async () => {
    const dir = join(HOME, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // user comment\n  "model": "claude"\n}\n');
    await installTarget(getTarget('opencode')!, installOpts('global'));
    const jsonc = readFileSync(join(dir, 'opencode.jsonc'), 'utf-8');
    expect(jsonc).toContain('// user comment');
    expect(jsonc).toContain('"model": "claude"');
    expect(jsonc).toContain('"rig"');
    expect(jsonc).toContain('"rig_rig_status": "allow"');
    expect(jsonc).toContain('"rig_rig_explore": "ask"');
  });

  test('openrouter writes mcp.json + AGENTS.md', async () => {
    const result = await installTarget(getTarget('openrouter')!, installOpts('global'));
    expect(result.applied).toHaveLength(2);
    expect(existsSync(join(HOME, '.config/openrouter/mcp.json'))).toBe(true);
    expect(existsSync(join(HOME, '.config/openrouter/AGENTS.md'))).toBe(true);
  });
});
