// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { allTargetNames, getTarget } from '../packages/cli/src/install/loader.ts';
import type { Scope } from '../packages/cli/src/install/paths.ts';
import { installTarget } from '../packages/cli/src/install/runner.ts';
import { isRigListEntry, isRigMapKey, isRigToolTable } from '../packages/cli/src/install/ownership.ts';
import { buildFiles } from '../scripts/gen.ts';

const GENERATED = resolve(__dirname, '../generated/installer');
const generated = (name: string) => JSON.parse(readFileSync(join(GENERATED, name), 'utf-8'));
const claude = generated('claude.permissions.json').permissions as { allow: string[]; ask: string[] };
const tools = (ids: string[]) => ids.map((id) => id.replace(/^mcp__rig__/, ''));

// Each host's documented per-tool approval config gets rig's policy, in that
// host's own format; hosts without one get no policy file at all.
describe('generated permission policies', () => {
  test('only targets that write a permissions file get a generated policy', async () => {
    const { files } = await buildFiles();
    const emitted = files
      .map((f) => /^installer\/(.+)\.permissions\.json$/.exec(f.path)?.[1])
      .filter((n): n is string => !!n)
      .sort();
    const declared = allTargetNames()
      .filter((n) => getTarget(n)!.files.some((f) => f.role === 'permissions'))
      .sort();
    expect(emitted).toEqual(declared);
    expect(emitted).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });

  test('cursor: Mcp(rig:<tool>) allow entries; ask tools are left to the default prompt', () => {
    const p = generated('cursor.permissions.json');
    expect(Object.keys(p.permissions)).toEqual(['allow']);
    expect(p.permissions.allow).toEqual(tools(claude.allow).map((t) => `Mcp(rig:${t})`));
  });

  test('codex: [mcp_servers.rig.tools.<tool>] approval_mode approve | prompt', () => {
    const t = generated('codex.permissions.json').mcp_servers.rig.tools as Record<string, { approval_mode: string }>;
    const byMode = (m: string) => Object.keys(t).filter((k) => t[k]!.approval_mode === m).sort();
    expect(byMode('approve')).toEqual(tools(claude.allow).sort());
    expect(byMode('prompt')).toEqual(tools(claude.ask).sort());
  });

  test('opencode: permission.rig_<tool> allow | ask', () => {
    const p = generated('opencode.permissions.json').permission as Record<string, string>;
    const byLevel = (l: string) => Object.keys(p).filter((k) => p[k] === l).sort();
    expect(byLevel('allow')).toEqual(tools(claude.allow).map((t) => `rig_${t}`).sort());
    expect(byLevel('ask')).toEqual(tools(claude.ask).map((t) => `rig_${t}`).sort());
  });

  test('the installer recognises every generated entry as rig-owned, and nothing else', () => {
    const lists = [...claude.allow, ...claude.ask, ...generated('cursor.permissions.json').permissions.allow];
    expect(lists.every(isRigListEntry)).toBe(true);
    expect(Object.keys(generated('opencode.permissions.json').permission).every(isRigMapKey)).toBe(true);
    const codexTools = Object.keys(generated('codex.permissions.json').mcp_servers.rig.tools);
    expect(codexTools.every((t) => isRigToolTable(`mcp_servers.rig.tools.${t}`))).toBe(true);
    // wildcards, server-wide rules and other servers stay the user's
    for (const e of ['mcp__rig__*', 'mcp__rig', 'mcp__other__rig_x', 'Mcp(rig:*)', 'Bash(rig_x)']) {
      expect(isRigListEntry(e)).toBe(false);
    }
    expect(isRigMapKey('rig_*')).toBe(false);
    expect(isRigMapKey('bash')).toBe(false);
    expect(isRigToolTable('mcp_servers.rig')).toBe(false);
  });
});

describe('writing the policy', () => {
  let base: string;
  let home: string;
  let project: string;
  const opts = (scope: Scope) => ({ rigBin: 'rig', generatedDir: GENERATED, home, projectRoot: project, scope });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'rig-perm-targets-'));
    home = join(base, 'home');
    project = join(base, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('codex: rig decides approval_mode, user keys and tables survive, idempotent', async () => {
    const cfg = join(home, '.codex/config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      cfg,
      [
        '[mcp_servers.rig]',
        'command = "old-rig"',
        '',
        '[[profiles]]',
        'name = "work"',
        '',
        '[mcp_servers.rig.tools.rig_search]',
        'output_token_limit = 5000',
        'approval_mode = "prompt"',
        '',
        '[mcp_servers.rig.tools.rig_explore]',
        'approval_mode = "approve"',
        '',
        '[mcp_servers.rig.tools.rig_gone]',
        'approval_mode = "approve"',
        'output_token_limit = 100',
        '',
      ].join('\n'),
    );
    await installTarget(getTarget('codex')!, opts('global'));
    const toml = readFileSync(cfg, 'utf-8');
    // the array-of-tables right after rig's server table is untouched
    expect(toml).toContain('[[profiles]]\nname = "work"\n');
    expect(toml).toContain('command = "rig"');
    expect(toml).not.toContain('old-rig');
    // rig's policy sets approval_mode; the user's other keys stay
    expect(toml).toContain('[mcp_servers.rig.tools.rig_search]\noutput_token_limit = 5000\napproval_mode = "approve"');
    expect(toml).toContain('[mcp_servers.rig.tools.rig_explore]\napproval_mode = "prompt"');
    expect(toml).toContain('[mcp_servers.rig.tools.rig_status]\napproval_mode = "approve"');
    // a tool rig no longer ships loses rig's key but keeps the user's
    expect(toml).toContain('[mcp_servers.rig.tools.rig_gone]\noutput_token_limit = 100');
    expect(toml).not.toMatch(/rig_gone\]\napproval_mode/);

    const again = await installTarget(getTarget('codex')!, opts('global'));
    expect(again.applied.every((a) => !a.changed)).toBe(true);
    expect(readFileSync(cfg, 'utf-8')).toBe(toml);
  });

  test('opencode: shorthand expanded, comments kept, rig decides rig_* keys, idempotent', async () => {
    const cfg = join(home, '.config/opencode/opencode.jsonc');
    mkdirSync(join(home, '.config/opencode'), { recursive: true });
    writeFileSync(cfg, '{\n  // mine\n  "permission": "ask"\n}\n');
    await installTarget(getTarget('opencode')!, opts('global'));
    let text = readFileSync(cfg, 'utf-8');
    expect(text).toContain('// mine');
    let perm = parseJsonc(text).permission;
    expect(perm['*']).toBe('ask');
    expect(Object.keys(perm)[0]).toBe('*'); // rig's per-tool keys come after the catch-all
    expect(perm.rig_rig_status).toBe('allow');
    expect(perm.rig_rig_explore).toBe('ask');

    // edits to rig's keys are reset to rig's policy; a key for a tool rig no
    // longer ships goes; the user's own keys stay
    writeFileSync(
      cfg,
      text
        .replace('"rig_rig_status": "allow"', '"rig_rig_status": "deny"')
        .replace('"rig_rig_explore": "ask"', '"rig_rig_explore": "allow"')
        .replace('"*": "ask",', '"*": "ask",\n    "rig_rig_gone": "allow",\n    "mymcp_*": "deny",'),
    );
    await installTarget(getTarget('opencode')!, opts('global'));
    text = readFileSync(cfg, 'utf-8');
    perm = parseJsonc(text).permission;
    expect(perm.rig_rig_status).toBe('allow');
    expect(perm.rig_rig_explore).toBe('ask');
    expect(perm.rig_rig_gone).toBeUndefined();
    expect(perm['mymcp_*']).toBe('deny');
    expect(perm['*']).toBe('ask');
    const again = await installTarget(getTarget('opencode')!, opts('global'));
    expect(again.applied.every((a) => !a.changed)).toBe(true);
  });

  test("cursor: .cursor/cli.json gets rig's allow entries next to the user's", async () => {
    mkdirSync(join(project, '.cursor'), { recursive: true });
    writeFileSync(
      join(project, '.cursor/cli.json'),
      JSON.stringify({ permissions: { allow: ['Shell(git)'], deny: ['Shell(rm)', 'Mcp(rig:rig_status)'] } }),
    );
    await installTarget(getTarget('cursor')!, opts('project'));
    const p = JSON.parse(readFileSync(join(project, '.cursor/cli.json'), 'utf-8')).permissions;
    expect(p.allow[0]).toBe('Shell(git)');
    expect(p.allow).toContain('Mcp(rig:rig_status)');
    expect(p.allow).not.toContain('Mcp(rig:rig_explore)');
    // rig's policy places its own entries; the user's deny rules stay
    expect(p.deny).toEqual(['Shell(rm)']);
  });
});
