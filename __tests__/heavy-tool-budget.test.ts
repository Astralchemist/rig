// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import type { ToolContext } from '@rig/mcp/dispatch.ts';
import { HEAVY_RESPONSE_BUDGET, fitSources } from '@rig/mcp/tool-impls/_budget.ts';
import { rigContextHandler } from '../generated/mcp/handlers/rig_context.handler.ts';
import { rigExploreHandler } from '../generated/mcp/handlers/rig_explore.handler.ts';

const MARKER = /… \[truncated: \d+ of \d+ lines shown\]$/;

interface Anchor {
  name: string;
  source: string;
}

// ~4,000 lines × ~80 chars, with quotes and backslashes so JSON escaping
// inflates the wire size beyond the raw character count.
const hugeBody = Array.from(
  { length: 4000 },
  (_, i) => `  total += ${i}; // "padding" \\ to make this line long enough to matter`,
).join('\n');

// rig_context / rig_explore return source bodies; Claude Code rejects a tool
// response over 25k tokens, so the serialized response must stay under budget.
describe('heavy tool response budget', () => {
  let project: string;
  let rig: Rig;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-heavy-budget-'));
    writeFileSync(
      join(project, 'huge.ts'),
      `export function hugeThing(): number {\n  let total = 0;\n${hugeBody}\n  return total;\n}\n\nexport function hugeHelper(): number {\n  return 1;\n}\n`,
    );
    writeFileSync(join(project, 'small.ts'), `export function tinyThing(): number {\n  return 1;\n}\n`);
    writeFileSync(
      join(project, 'probes.ts'),
      Array.from({ length: 6 }, (_, i) => `export function capProbe${i}(): number {\n  return ${i};\n}\n`).join('\n'),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterAll(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    rig,
    sessionId: 'test',
    provenance: null,
    recordActivation: () => {},
  });

  // What the MCP layer actually sends: JSON.stringify of the handler result.
  const wire = (result: unknown): number => JSON.stringify(result).length;

  test('fixture is far over budget before trimming', () => {
    expect(hugeBody.length).toBeGreaterThan(HEAVY_RESPONSE_BUDGET * 3);
  });

  test('rig_context (markdown) is trimmed under budget with a marker', async () => {
    const result = (await rigContextHandler.run({ task: 'hugeThing' }, ctx())) as {
      context: string;
      anchor_count: number;
      truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(wire(result)).toBeLessThanOrEqual(HEAVY_RESPONSE_BUDGET);
    expect(result.anchor_count).toBeGreaterThan(0);
    expect(result.context).toContain('export function hugeThing(): number {');
    expect(result.context).toMatch(/… \[truncated: \d+ of 4004 lines shown\]/);
    expect(result.context).not.toContain('return total;');
  });

  test('rig_context (json) stays valid JSON under budget', async () => {
    const result = (await rigContextHandler.run({ task: 'hugeThing', format: 'json' }, ctx())) as {
      context: string;
      truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(wire(result)).toBeLessThanOrEqual(HEAVY_RESPONSE_BUDGET);
    const blocks = JSON.parse(result.context) as Anchor[];
    expect(blocks.find((b) => b.name === 'hugeThing')?.source).toMatch(MARKER);
  });

  test('rig_explore is trimmed under budget; small anchors keep their whole source', async () => {
    const result = (await rigExploreHandler.run({ question: 'huge' }, ctx())) as {
      anchors: Anchor[];
      truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(wire(result)).toBeLessThanOrEqual(HEAVY_RESPONSE_BUDGET);
    const names = result.anchors.map((a) => a.name);
    expect(names).toContain('hugeThing');
    expect(names).toContain('hugeHelper');
    expect(result.anchors.find((a) => a.name === 'hugeThing')!.source).toMatch(MARKER);
    // One huge anchor doesn't starve the rest.
    expect(result.anchors.find((a) => a.name === 'hugeHelper')!.source).toBe(
      'export function hugeHelper(): number {\n  return 1;\n}',
    );
  });

  test('small results pass through untouched', async () => {
    const result = (await rigContextHandler.run({ task: 'tinyThing' }, ctx())) as {
      context: string;
      truncated: boolean;
    };
    expect(result.truncated).toBe(false);
    expect(result.context).toContain('export function tinyThing(): number {\n  return 1;\n}');
    expect(result.context).not.toContain('[truncated');
  });

  test('max_anchors / max_nodes cap the anchor count', async () => {
    const explored = (await rigExploreHandler.run({ question: 'capProbe', max_anchors: 3 }, ctx())) as {
      anchors: Anchor[];
    };
    expect(explored.anchors).toHaveLength(3);
    const bundle = (await rigContextHandler.run({ task: 'capProbe', max_nodes: 2 }, ctx())) as {
      anchor_count: number;
    };
    expect(bundle.anchor_count).toBe(2);
  });

  test('escape-heavy sources are trimmed to fit, not dropped', () => {
    // Raw characters fit the budget; double JSON escaping (format=json) does not.
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `q${i}`, source: '";\n'.repeat(500 + i * 20) }));
    const render = (xs: readonly { name: string; source: string }[]): string =>
      JSON.stringify({ context: JSON.stringify(xs, null, 2) });
    expect(items.reduce((n, it) => n + it.source.length, 0)).toBeLessThan(HEAVY_RESPONSE_BUDGET);
    expect(render(items).length).toBeGreaterThan(HEAVY_RESPONSE_BUDGET);
    const fitted = fitSources(items, render);
    expect(fitted.truncated).toBe(true);
    expect(render(fitted.items).length).toBeLessThanOrEqual(HEAVY_RESPONSE_BUDGET);
    expect(render(fitted.items).length).toBeGreaterThan(HEAVY_RESPONSE_BUDGET * 0.8);
  });

  test('a single minified line is cut inside the line', () => {
    const line = 'x'.repeat(HEAVY_RESPONSE_BUDGET * 2);
    const { items, truncated } = fitSources([{ source: line }], (xs) => JSON.stringify({ anchors: xs }));
    expect(truncated).toBe(true);
    expect(JSON.stringify({ anchors: items }).length).toBeLessThanOrEqual(HEAVY_RESPONSE_BUDGET);
    expect(items[0]!.source.startsWith('x'.repeat(1000))).toBe(true);
    expect(items[0]!.source).toMatch(MARKER);
  });
});
