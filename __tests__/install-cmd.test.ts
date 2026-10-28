// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './support/cli.ts';

// `rig install` end to end, in a child process with a temporary HOME.
describe('rig install — scope', () => {
  let base: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-install-cmd-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('`rig install claude` writes project files only and lists them', () => {
    const r = runCli(['install', 'claude'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`rig install claude (project: ${project})`);
    for (const f of ['.mcp.json', '.claude/settings.json', 'CLAUDE.md']) {
      expect(r.stdout).toContain(`✓ wrote`);
      expect(r.stdout).toContain(` ${f}\n`);
      expect(existsSync(join(project, f))).toBe(true);
    }
    expect(r.stdout).toContain('note: Claude Code asks once');
    expect(readdirSync(home)).toEqual([]);
  });

  test('`--global` keeps the old user-level behaviour', () => {
    const r = runCli(['install', 'claude', '--global'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('rig install claude (global: ~)');
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')).mcpServers.rig.command).toBe('rig');
    expect(existsSync(join(home, '.claude/settings.json'))).toBe(true);
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(true);
    expect(r.stdout).toContain(' ~/.claude.json\n');
    expect(readdirSync(project)).toEqual([]);
  });

  test('a project install points out an older user-wide one', () => {
    runCli(['install', 'claude', '--global'], { cwd: project, home });
    const r = runCli(['install', 'claude'], { cwd: project, home });
    expect(r.stdout).toContain(
      'note: rig is also wired user-wide in ~/.claude.json — `rig uninstall claude --global` removes that.',
    );
  });

  test('refuses a project-scoped install in the home directory', () => {
    const r = runCli(['install', 'claude'], { cwd: home, home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is your home directory');
    expect(readdirSync(home)).toEqual([]);
  });

  test('a target with only user-level config falls back to it and says so', () => {
    const r = runCli(['install', 'codex'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no project-level config');
    expect(existsSync(join(home, '.codex/config.toml'))).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  });

  test('--bin takes a value that is not mistaken for a target', () => {
    const r = runCli(['install', '--bin', '/opt/rig/bin/rig', 'claude'], { cwd: project, home });
    expect(r.code).toBe(0);
    const mcp = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.rig.command).toBe('/opt/rig/bin/rig');
  });

  test('--dry-run writes nothing', () => {
    const r = runCli(['install', 'claude', '--dry-run'], { cwd: project, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('(dry run)');
    expect(readdirSync(project)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test('unknown targets are rejected before anything is written', () => {
    const r = runCli(['install', 'claude', 'nope'], { cwd: project, home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown target 'nope'");
    expect(readdirSync(project)).toEqual([]);
  });
});
