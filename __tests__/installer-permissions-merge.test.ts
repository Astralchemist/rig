// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deepMerge, permissionsUnion } from '../packages/cli/src/install/json-merge.ts';
import { applyFile } from '../packages/cli/src/install/modes.ts';

const GENERATED = resolve(__dirname, '../generated/installer');
const policy = JSON.parse(readFileSync(join(GENERATED, 'claude.permissions.json'), 'utf-8')) as {
  permissions: { allow: string[]; ask: string[] };
};

// Issue #8 — re-installing refreshes rig's permission entries without
// dropping the user's. rig's current policy decides where rig's own entries
// (mcp__rig__<tool>, Mcp(rig:<tool>)) go; every other entry is the user's.
describe('installer — permission lists on re-install (#8)', () => {
  let dir: string;
  let settingsPath: string;
  let generatedDir: string;

  const permissionsFile = (name = 'claude') => ({
    role: 'permissions',
    path: settingsPath,
    mode: 'merge-json',
    template: `{{GENERATED:${name}.permissions.json}}`,
  });
  const install = (name = 'claude') => applyFile(permissionsFile(name), { rigBin: 'rig', generatedDir });
  const read = () => JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const seed = (value: unknown) => writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n');
  // A policy as a later rig release might ship it (e.g. write tools moved to ask).
  const withPolicy = (name: string, value: unknown) => {
    generatedDir = join(dir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, `${name}.permissions.json`), JSON.stringify(value));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-perm-merge-'));
    settingsPath = join(dir, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    generatedDir = GENERATED;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('keeps user-added entries, adds rig entries, dedupes', async () => {
    // An install from before the write tools existed, plus the user's own rules.
    seed({
      model: 'opus',
      permissions: {
        allow: ['Bash(npm test)', 'mcp__rig__rig_status', 'mcp__rig__rig_status'],
        deny: ['Read(./.env)'],
      },
    });
    const r = await install();
    expect(r.status).toBe('wrote');

    const s = read();
    expect(s.model).toBe('opus');
    expect(s.permissions.deny).toEqual(['Read(./.env)']);
    // user entry survives, first and in place
    expect(s.permissions.allow[0]).toBe('Bash(npm test)');
    for (const id of policy.permissions.allow) expect(s.permissions.allow).toContain(id);
    expect(s.permissions.ask).toEqual(policy.permissions.ask);
    // no duplicates anywhere
    expect(new Set(s.permissions.allow).size).toBe(s.permissions.allow.length);
  });

  test('a tool the new policy moves from allow to ask ends up only in ask', async () => {
    withPolicy('claude', {
      permissions: { allow: ['mcp__rig__rig_status'], ask: ['mcp__rig__rig_promote'] },
    });
    seed({ permissions: { allow: ['mcp__rig__rig_promote', 'Bash(npm test)', 'mcp__rig__rig_status'] } });
    await install();
    const p = read().permissions;
    expect(p.ask).toEqual(['mcp__rig__rig_promote']);
    expect(p.allow).toEqual(['Bash(npm test)', 'mcp__rig__rig_status']);
  });

  test('rig-owned entries leave every list the policy does not put them in', async () => {
    withPolicy('claude', { permissions: { allow: ['mcp__rig__rig_status'], ask: ['mcp__rig__rig_explore'] } });
    seed({
      permissions: {
        allow: ['mcp__rig__rig_explore', 'mcp__rig__rig_gone', 'mcp__rig__*', 'mcp__other__tool'],
        ask: ['mcp__rig__rig_status', 'Bash(rm *)'],
        deny: ['mcp__rig__rig_explore', 'mcp__rig', 'Read(./.env)'],
      },
    });
    await install();
    const p = read().permissions;
    // rig's two tools sit exactly where the policy says; a tool rig no longer
    // ships is gone; wildcards, server-wide rules and other servers are the user's
    expect(p.allow).toEqual(['mcp__rig__*', 'mcp__other__tool', 'mcp__rig__rig_status']);
    expect(p.ask).toEqual(['Bash(rm *)', 'mcp__rig__rig_explore']);
    expect(p.deny).toEqual(['mcp__rig', 'Read(./.env)']);
  });

  test('the same holds for the Cursor CLI vocabulary', async () => {
    withPolicy('cursor', { permissions: { allow: ['Mcp(rig:rig_status)'] } });
    seed({ permissions: { allow: ['Shell(git)', 'Mcp(rig:rig_promote)', 'Mcp(rig:*)'], deny: ['Mcp(rig:rig_status)'] } });
    await install('cursor');
    const p = read().permissions;
    expect(p.allow).toEqual(['Shell(git)', 'Mcp(rig:*)', 'Mcp(rig:rig_status)']);
    expect(p.deny).toEqual([]);
  });

  test('user entries added to `ask` survive a re-install', async () => {
    await install();
    const s = read();
    s.permissions.ask.push('mcp__other__dangerous');
    seed(s);
    await install();
    expect(read().permissions.ask).toContain('mcp__other__dangerous');
  });

  test('re-install is idempotent (byte-identical second run)', async () => {
    seed({ permissions: { allow: ['Bash(ls)'] } });
    await install();
    const first = readFileSync(settingsPath, 'utf-8');
    const second = await install();
    expect(second.status).toBe('unchanged');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(first);
  });

  test('only permission lists union; other arrays (server args) are replaced', () => {
    const merged = deepMerge(
      { mcpServers: { rig: { args: ['serve'] } }, permissions: { allow: ['a'] } },
      { mcpServers: { rig: { args: ['serve', '--mcp'] } }, permissions: { allow: ['b', 'a'] } },
      { union: permissionsUnion },
    ) as { mcpServers: { rig: { args: string[] } }; permissions: { allow: string[] } };
    expect(merged.mcpServers.rig.args).toEqual(['serve', '--mcp']);
    expect(merged.permissions.allow).toEqual(['a', 'b']);
  });
});
