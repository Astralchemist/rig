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

// Issue #8 — re-installing must refresh rig's permission entries without
// dropping entries the user added to the same lists.
describe('installer — permission lists merge as a union (#8)', () => {
  let dir: string;
  let settingsPath: string;
  const ctx = () => ({ rigBin: 'rig', cursorPath: dir, generatedDir: GENERATED });
  const permissionsFile = () => ({
    role: 'permissions',
    path: settingsPath,
    mode: 'merge-json',
    template: '{{GENERATED:claude.permissions.json}}',
  });
  const read = () => JSON.parse(readFileSync(settingsPath, 'utf-8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-perm-merge-'));
    settingsPath = join(dir, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('keeps user-added entries, adds rig entries, dedupes', async () => {
    // An install from before the write tools existed, plus the user's own rules.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        permissions: {
          allow: ['Bash(npm test)', 'mcp__rig__rig_status', 'mcp__rig__rig_status'],
          deny: ['Read(./.env)'],
        },
      }),
    );
    const r = await applyFile(permissionsFile(), ctx());
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
    expect(s.permissions.allow.filter((x: string) => x === 'mcp__rig__rig_status')).toHaveLength(1);
  });

  test('user entries added to `ask` survive a re-install', async () => {
    await applyFile(permissionsFile(), ctx());
    const s = read();
    s.permissions.ask.push('mcp__other__dangerous');
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');

    await applyFile(permissionsFile(), ctx());
    expect(read().permissions.ask).toContain('mcp__other__dangerous');
  });

  test('re-install is idempotent (byte-identical second run)', async () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    await applyFile(permissionsFile(), ctx());
    const first = readFileSync(settingsPath, 'utf-8');
    const second = await applyFile(permissionsFile(), ctx());
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
