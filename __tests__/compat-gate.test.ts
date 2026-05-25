// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCompat, type ToolEntry } from '../scripts/gen/compat.ts';
import { buildFiles } from '../scripts/gen.ts';

const ROOT = resolve(__dirname, '..');

const stablePull: ToolEntry = {
  name: 'rig_pull',
  tier: 'light',
  stability: 'stable',
  inputSchema: { properties: { id: {}, k: {} }, required: ['id'] },
  outputSchema: { properties: { results: {} } },
  errors: ['NODE_NOT_FOUND'],
};

describe('compat classifier', () => {
  test('no changes → empty', () => {
    expect(classifyCompat([stablePull], [stablePull])).toHaveLength(0);
  });

  test('stable tool: removed/required input, dropped output + error all breaking', () => {
    const broken: ToolEntry = {
      ...stablePull,
      inputSchema: { properties: { id: {} }, required: ['id', 'k'] },
      outputSchema: { properties: {} },
      errors: [],
    };
    const breaking = classifyCompat([stablePull], [broken]).filter((c) => c.severity === 'breaking');
    expect(breaking.map((c) => c.detail).sort()).toEqual([
      "error 'NODE_NOT_FOUND' removed",
      "input 'k' newly required",
      "input 'k' removed",
      "output 'results' removed",
    ]);
  });

  test('experimental tool: same changes are exempt (not breaking)', () => {
    const exp = { ...stablePull, stability: 'experimental' as const };
    const broken: ToolEntry = { ...exp, outputSchema: { properties: {} }, errors: [] };
    expect(classifyCompat([exp], [broken]).filter((c) => c.severity === 'breaking')).toHaveLength(0);
  });

  test('additive: new optional input, new output field, new tool are allowed', () => {
    const grown: ToolEntry = {
      ...stablePull,
      inputSchema: { properties: { id: {}, k: {}, hub_bias: {} }, required: ['id'] },
      outputSchema: { properties: { results: {}, elapsed_ms: {} } },
      errors: ['NODE_NOT_FOUND', 'NOT_INITIALIZED'],
    };
    const newTool: ToolEntry = { name: 'rig_new', tier: 'light', stability: 'experimental' };
    const changes = classifyCompat([stablePull], [grown, newTool]);
    expect(changes.every((c) => c.severity === 'additive')).toBe(true);
    expect(changes.some((c) => c.tool === 'rig_new' && c.detail === 'new tool')).toBe(true);
  });

  test('blessed snapshot matches the current built manifest (run `bun run compat:snapshot` if intentional)', async () => {
    const snap = JSON.parse(
      readFileSync(resolve(ROOT, 'compat/tools-manifest.snapshot.json'), 'utf-8'),
    ) as { version: number; tools: ToolEntry[] };
    const { files } = await buildFiles();
    const built = JSON.parse(files.find((f) => f.path === 'mcp/tools-manifest.json')!.content) as {
      version: number;
      tools: ToolEntry[];
    };
    const majorBump = Math.trunc(built.version) > Math.trunc(snap.version);
    const breaking = classifyCompat(snap.tools, built.tools).filter((c) => c.severity === 'breaking');
    expect(majorBump || breaking.length === 0).toBe(true);
  });
});
