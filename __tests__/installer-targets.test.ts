import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';

const GENERATED = resolve(__dirname, '../generated/installer');

const installOpts = (home: string) => ({
  rigBin: 'rig',
  cursorPath: home,
  generatedDir: GENERATED,
  home,
});

describe('installer targets', () => {
  let HOME: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    HOME = mkdtempSync(join(tmpdir(), 'rig-installer-'));
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = HOME;
    process.chdir(HOME);
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    process.chdir(originalCwd);
    rmSync(HOME, { recursive: true, force: true });
  });

  test('claude writes 3 files with expected content', async () => {
    const result = await installTarget(getTarget('claude')!, installOpts(HOME));
    expect(result.applied).toHaveLength(3);
    expect(result.applied.every((a) => a.changed)).toBe(true);

    const claudeJson = JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf-8'));
    expect(claudeJson.mcpServers.rig.command).toBe('rig');
    expect(claudeJson.mcpServers.rig.args).toEqual(['serve', '--mcp']);

    const settings = JSON.parse(readFileSync(join(HOME, '.claude/settings.json'), 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__rig__rig_status');
    expect(settings.permissions.ask).toContain('mcp__rig__rig_explore');
    expect(settings.permissions.ask).toContain('mcp__rig__rig_context');

    const md = readFileSync(join(HOME, '.claude/CLAUDE.md'), 'utf-8');
    expect(md).toContain('<!-- rig:begin -->');
    expect(md).toContain('rig_status');
  });

  test('claude install is idempotent on a second run', async () => {
    const opts = installOpts(HOME);
    await installTarget(getTarget('claude')!, opts);
    const second = await installTarget(getTarget('claude')!, opts);
    expect(second.applied.every((a) => !a.changed)).toBe(true);
  });

  test('cursor writes mcp.json (merge-json) + rig.mdc (replace) with frontmatter', async () => {
    const result = await installTarget(getTarget('cursor')!, installOpts(HOME));
    expect(result.applied).toHaveLength(2);
    const mcp = JSON.parse(readFileSync(join(HOME, '.cursor/mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.rig.args).toContain('--path');
    const mdc = readFileSync(join(HOME, '.cursor/rules/rig.mdc'), 'utf-8');
    expect(mdc.startsWith('---\n')).toBe(true);
    expect(mdc).toContain('alwaysApply: true');
  });

  test('codex writes [mcp_servers.rig] TOML table preserving sibling tables', async () => {
    // Pre-seed file with a sibling table that must survive the install.
    const codexDir = join(HOME, '.codex');
    require('node:fs').mkdirSync(codexDir, { recursive: true });
    require('node:fs').writeFileSync(
      join(codexDir, 'config.toml'),
      '[model]\nname = "gpt-4"\n',
    );
    await installTarget(getTarget('codex')!, installOpts(HOME));
    const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.rig]');
    expect(toml).toContain('command = "rig"');
    expect(toml).toContain('[model]');
    expect(toml).toContain('name = "gpt-4"');
  });

  test('opencode merge-jsonc preserves user comments', async () => {
    const dir = join(HOME, '.config', 'opencode');
    require('node:fs').mkdirSync(dir, { recursive: true });
    require('node:fs').writeFileSync(
      join(dir, 'opencode.jsonc'),
      '{\n  // user comment\n  "model": "claude"\n}\n',
    );
    await installTarget(getTarget('opencode')!, installOpts(HOME));
    const jsonc = readFileSync(join(dir, 'opencode.jsonc'), 'utf-8');
    expect(jsonc).toContain('// user comment');
    expect(jsonc).toContain('"model": "claude"');
    expect(jsonc).toContain('"rig"');
  });

  test('openrouter writes mcp.json + AGENTS.md', async () => {
    const result = await installTarget(getTarget('openrouter')!, installOpts(HOME));
    expect(result.applied).toHaveLength(2);
    expect(existsSync(join(HOME, '.config/openrouter/mcp.json'))).toBe(true);
    expect(existsSync(join(HOME, '.config/openrouter/AGENTS.md'))).toBe(true);
  });
});
