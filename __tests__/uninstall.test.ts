// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import type { Scope } from '../packages/cli/src/install/paths.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { uninstallTarget } from '../packages/cli/src/install/uninstall.ts';
import { runCli } from './support/cli.ts';

const GENERATED = resolve(__dirname, '../generated/installer');
const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

// `rig uninstall` removes exactly what `rig install` added and nothing else.
describe('uninstall', () => {
  let base: string;
  let home: string;
  let project: string;

  const opts = (scope: Scope, dryRun = false) => ({
    rigBin: 'rig',
    generatedDir: GENERATED,
    home,
    projectRoot: project,
    scope,
    dryRun,
  });
  const install = (name: string, scope: Scope) => installTarget(getTarget(name)!, opts(scope));
  const uninstall = (name: string, scope: Scope, dryRun = false) =>
    uninstallTarget(getTarget(name)!, opts(scope, dryRun));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const read = (path: string) => readFileSync(path, 'utf-8');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-uninstall-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('claude, project: restores files that had user content byte for byte', async () => {
    const originals = {
      '.mcp.json': pretty({ mcpServers: { db: { command: 'db-mcp', args: [] } } }),
      '.claude/settings.json': pretty({ permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] } }),
      'CLAUDE.md': '# Project\n\nUse pnpm.\n',
    };
    for (const [f, c] of Object.entries(originals)) write(join(project, f), c);

    await install('claude', 'project');
    const result = await uninstall('claude', 'project');

    for (const [f, c] of Object.entries(originals)) expect(read(join(project, f))).toBe(c);
    expect(result.removed.map((r) => [r.role, r.status])).toEqual([
      ['instructions', 'removed'],
      ['permissions', 'removed'],
      ['mcp_config', 'removed'],
    ]);
    expect(result.removed[2]!.detail).toBe('mcpServers.rig');
    expect(result.removed[1]!.detail).toMatch(/^\d+ rig entries$/);
  });

  test('claude, project: files rig created are deleted, with their emptied dirs', async () => {
    await install('claude', 'project');
    const result = await uninstall('claude', 'project');
    expect(result.removed.every((r) => r.status === 'deleted')).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  });

  test('only rig-owned permission entries go — from every list, stale ones too', async () => {
    write(join(project, '.claude/settings.json'), pretty({ permissions: { allow: ['Bash(npm test)'] } }));
    await install('claude', 'project');
    const path = join(project, '.claude/settings.json');
    const s = JSON.parse(read(path));
    s.permissions.allow.push('mcp__rig__*', 'mcp__rig__rig_gone');
    s.permissions.ask.push('mcp__other__tool');
    s.permissions.deny = ['mcp__rig__rig_undo', 'mcp__rig', 'Read(./.env)'];
    write(path, pretty(s));

    await uninstall('claude', 'project');
    expect(JSON.parse(read(path)).permissions).toEqual({
      allow: ['Bash(npm test)', 'mcp__rig__*'],
      ask: ['mcp__other__tool'],
      deny: ['mcp__rig', 'Read(./.env)'],
    });
  });

  test('claude, --global: ~/.claude.json keeps everything but rig', async () => {
    const claudeJson = pretty({ numStartups: 3, mcpServers: { other: { command: 'x' } }, projects: {} });
    write(join(home, '.claude.json'), claudeJson);
    await install('claude', 'global');
    await uninstall('claude', 'global');
    expect(read(join(home, '.claude.json'))).toBe(claudeJson);
    expect(existsSync(join(home, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false);
    // user-level directories are never pruned
    expect(existsSync(join(home, '.claude'))).toBe(true);
  });

  test("cursor, project: rig's files go, the user's rules stay", async () => {
    await install('cursor', 'project');
    write(join(project, '.cursor/rules/mine.mdc'), '---\nalwaysApply: true\n---\nmine\n');
    await uninstall('cursor', 'project');
    expect(readdirSync(join(project, '.cursor'))).toEqual(['rules']);
    expect(readdirSync(join(project, '.cursor/rules'))).toEqual(['mine.mdc']);
  });

  test('a rule file at rig.mdc that rig did not generate is left in place', async () => {
    write(join(project, '.cursor/rules/rig.mdc'), 'my own notes about rigging\n');
    const result = await uninstall('cursor', 'project');
    expect(read(join(project, '.cursor/rules/rig.mdc'))).toBe('my own notes about rigging\n');
    expect(result.removed.find((r) => r.role === 'instructions')!.status).toBe('kept');
  });

  test('codex: config.toml goes back to what it was; rig sub-tables go with the entry', async () => {
    const original = '[model]\nname = "gpt-5"\n\n[[profiles]]\nname = "work"\n';
    write(join(home, '.codex/config.toml'), original);
    await install('codex', 'global');
    // a user tweak under rig's entry — meaningless once the entry is gone
    write(join(home, '.codex/config.toml'), read(join(home, '.codex/config.toml')) + '\n[mcp_servers.rig.env]\nFOO = "1"\n');
    await uninstall('codex', 'global');
    expect(read(join(home, '.codex/config.toml'))).toBe(original);
    expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false);
  });

  test('opencode: comments and the user keys survive; rig keys and emptied objects go', async () => {
    write(join(home, '.config/opencode/opencode.jsonc'), '{\n  // mine\n  "model": "x",\n  "permission": { "bash": "ask" }\n}\n');
    await install('opencode', 'global');
    await uninstall('opencode', 'global');
    const text = read(join(home, '.config/opencode/opencode.jsonc'));
    expect(text).toContain('// mine');
    const doc = parseJsonc(text);
    expect(doc.mcp).toBeUndefined();
    expect(doc.permission).toEqual({ bash: 'ask' });
    expect(doc.model).toBe('x');
  });

  test('nothing installed: everything is absent and nothing is created', async () => {
    const result = await uninstall('claude', 'project');
    expect(result.removed.every((r) => r.status === 'absent')).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  });

  test('--dry-run reports the changes but makes none', async () => {
    await install('claude', 'project');
    const before = read(join(project, '.mcp.json'));
    const result = await uninstall('claude', 'project', true);
    expect(result.removed.every((r) => r.status === 'deleted')).toBe(true);
    expect(read(join(project, '.mcp.json'))).toBe(before);
  });
});

describe('rig uninstall (CLI)', () => {
  let base: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-uninstall-cli-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('needs a target or --all', () => {
    const r = runCli(['uninstall'], { cwd: project, home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: rig uninstall');
    expect(runCli(['uninstall', 'nope'], { cwd: project, home }).code).toBe(2);
  });

  test('prints what it removed', () => {
    expect(runCli(['install', 'claude'], { cwd: project, home }).code).toBe(0);
    const r = runCli(['uninstall', 'claude'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`rig uninstall claude (project: ${project})`);
    expect(r.stdout).toContain('✓ deleted      mcp_config   .mcp.json — mcpServers.rig — nothing else was in it');
    expect(r.stdout).toContain('✓ deleted      instructions CLAUDE.md — rig section — nothing else was in it');
    expect(r.stdout).toMatch(/✓ deleted {6}permissions {2}\.claude\/settings\.json — \d+ rig entries/);
    expect(readdirSync(project)).toEqual([]);
  });

  test('--all covers every target with project files and names the rest', () => {
    runCli(['install', 'claude', 'cursor'], { cwd: project, home });
    const r = runCli(['uninstall', '--all'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(readdirSync(project)).toEqual([]);
    expect(r.stdout).toContain('· Codex CLI: no project-level files — `rig uninstall codex --global` removes it');
  });

  test('a user-level-only target falls back to its user files; --global works for claude', () => {
    runCli(['install', 'codex'], { cwd: project, home });
    runCli(['install', 'claude', '--global'], { cwd: project, home });
    const codex = runCli(['uninstall', 'codex'], { cwd: project, home });
    expect(codex.stdout).toContain('removing its user-level ones instead');
    expect(existsSync(join(home, '.codex/config.toml'))).toBe(false);
    const claude = runCli(['uninstall', 'claude', '--global'], { cwd: project, home });
    expect(claude.stdout).toContain('rig uninstall claude (global: ~)');
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  test('refuses project scope in the home directory', () => {
    const r = runCli(['uninstall', 'claude'], { cwd: home, home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is your home directory');
  });
});
