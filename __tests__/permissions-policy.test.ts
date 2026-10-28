// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GENERATED = resolve(__dirname, '../generated');
const read = <T>(path: string): T => JSON.parse(readFileSync(resolve(GENERATED, path), 'utf-8'));

// Write tools that change the canonical graph, or roll it back, with nothing
// left for the user to accept in the map (rig_propose_edge only queues a
// pending edge). The agent asks first.
const NEEDS_APPROVAL = ['rig_promote', 'rig_undo', 'rig_add_alias', 'rig_add_node'];

describe('claude permissions policy (generated/installer/claude.permissions.json)', () => {
  const { permissions } = read<{ permissions: { allow: string[]; ask: string[] } }>(
    'installer/claude.permissions.json',
  );
  const { tools } = read<{ tools: { name: string; tier: string }[] }>('mcp/tools-manifest.json');

  test('asks before promote, undo, add_alias and add_node', () => {
    for (const name of NEEDS_APPROVAL) {
      expect(permissions.ask).toContain(`mcp__rig__${name}`);
      expect(permissions.allow).not.toContain(`mcp__rig__${name}`);
    }
  });

  test('asks before heavy tools and pre-approves every other tool', () => {
    for (const t of tools) {
      const asks = t.tier === 'heavy' || NEEDS_APPROVAL.includes(t.name);
      expect(asks ? permissions.ask : permissions.allow).toContain(`mcp__rig__${t.name}`);
    }
    expect(permissions.allow.length + permissions.ask.length).toBe(tools.length);
  });
});
