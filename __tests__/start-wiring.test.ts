// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TargetContract } from '../packages/contracts/src/index.ts';
import { getTarget } from '../packages/cli/src/install/loader.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { describeWiring, wireDetectedAgents } from '../packages/cli/src/install/wire.ts';

const GENERATED = resolve(__dirname, '../generated/installer');

// `rig start` auto-wiring: project scope only, and it reports every file.
describe('rig start — agent wiring', () => {
  let base: string;
  let home: string;
  let project: string;

  const detectOnly =
    (...names: string[]) =>
    async (t: TargetContract): Promise<boolean> =>
      names.includes(t.name);

  const wire = (detect: (t: TargetContract) => Promise<boolean>, projectRoot = project) =>
    wireDetectedAgents({
      rigBin: 'rig',
      generatedDir: GENERATED,
      projectRoot,
      home,
      detect,
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-start-wire-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('wires detected agents into the project and never writes user config', async () => {
    const report = await wire(detectOnly('claude', 'cursor', 'codex'));
    expect(report.wired.map((w) => w.target)).toEqual(['claude', 'cursor']);
    expect(report.wired.every((w) => w.scope === 'project')).toBe(true);
    expect(report.userLevelOnly).toEqual(['codex']);

    for (const f of ['.mcp.json', '.claude/settings.json', 'CLAUDE.md', '.cursor/mcp.json', '.cursor/rules/rig.mdc']) {
      expect(existsSync(join(project, f))).toBe(true);
    }
    expect(readdirSync(home)).toEqual([]);
  });

  test('prints every file it wrote, then the approval note', async () => {
    const lines = describeWiring(await wire(detectOnly('claude', 'codex')), project, home);
    const claude = lines.find((l) => l.label === 'wired Claude Code')!;
    expect(claude.ok).toBe(true);
    expect(claude.detail).toBe('project');
    expect(claude.files).toEqual([
      'wrote     .mcp.json',
      'wrote     .claude/settings.json',
      'wrote     CLAUDE.md',
      expect.stringMatching(/^note {6}Claude Code asks once/),
    ]);
    const codex = lines.find((l) => l.label === 'Codex CLI detected')!;
    expect(codex.ok).toBe(false);
    expect(codex.detail).toContain('rig install codex');
  });

  test('a re-run reports unchanged files and drops the one-time note', async () => {
    await wire(detectOnly('claude'));
    const lines = describeWiring(await wire(detectOnly('claude')), project, home);
    expect(lines[0]!.files).toEqual([
      'unchanged .mcp.json',
      'unchanged .claude/settings.json',
      'unchanged CLAUDE.md',
    ]);
  });

  test('points out a leftover user-wide install, with the command that removes it', async () => {
    await installTarget(getTarget('claude')!, { rigBin: 'rig', generatedDir: GENERATED, home, projectRoot: project, scope: 'global' });
    const lines = describeWiring(await wire(detectOnly('claude')), project, home);
    expect(lines[0]!.files.at(-1)).toBe(
      'note      also wired user-wide in ~/.claude.json — `rig uninstall claude --global` removes that',
    );
  });

  test('does nothing in the home directory', async () => {
    const report = await wire(detectOnly('claude'), home);
    expect(report.skippedHome).toBe(true);
    expect(report.wired).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
    expect(describeWiring(report, home, home)[0]!.label).toBe('not wiring agents');
  });

  test('says so when no agent is detected', async () => {
    const lines = describeWiring(await wire(detectOnly()), project, home);
    expect(lines).toEqual([
      { ok: false, label: 'no agents detected', detail: 'run `rig install <target>` later', files: [] },
    ]);
    expect(readdirSync(project)).toEqual([]);
  });
});
