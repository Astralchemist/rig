// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { extractFromSource } from '../packages/core/src/extract/extractor.ts';
import type { Node } from '../packages/core/src/extract/upstream-types.ts';
import { reconcileNodes, type StoredNode } from '../packages/core/src/reconcile-nodes.ts';

// reconcileNodes decides which stored row each freshly extracted node updates.
// Ids must follow the symbol (kind + qualifiedName + ordinal), never the line.

const stored = (nodes: readonly Node[]): StoredNode[] =>
  nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    qualifiedName: n.qualifiedName,
    startLine: n.startLine,
    startColumn: n.startColumn,
  }));

const extract = async (path: string, source: string): Promise<Node[]> =>
  (await extractFromSource(path, source)).nodes;

const byQn = (nodes: readonly { node: Node }[]): Map<string, string> =>
  new Map(nodes.map((r) => [`${r.node.kind} ${r.node.qualifiedName}`, r.node.id]));

describe('reconcileNodes', () => {
  test('a line shift keeps every id', async () => {
    const before = await extract(
      'a.ts',
      `export class A { run(): void {} }\nexport function f(): void {}\n`,
    );
    const after = await extract(
      'a.ts',
      `// moved\n\nexport class A { run(): void {} }\nexport function f(): void {}\n`,
    );
    const r = reconcileNodes(stored(before), after, () => false);
    expect(r.removed).toEqual([]);
    expect(r.nodes.every((n) => n.storedId === n.node.id)).toBe(true);
    expect(byQn(r.nodes)).toEqual(byQn(before.map((node) => ({ node }))));
  });

  test('a same-named method inserted above keeps the original on its id', async () => {
    const before = await extract('a.ts', `export class A {\n  run(): void {}\n}\n`);
    // B.run lands on the line A.run used to occupy, so its generated id is the
    // stored id of A.run; A.run must keep it and B.run gets a fresh one.
    const after = await extract(
      'a.ts',
      `export class B {\n  run(): void {}\n}\nexport class A {\n  run(): void {}\n}\n`,
    );
    const aRunBefore = before.find((n) => n.qualifiedName === 'A.run')!;
    const bRunGenerated = after.find((n) => n.qualifiedName === 'B.run')!;
    expect(bRunGenerated.id).toBe(aRunBefore.id); // same kind, name and line
    const r = reconcileNodes(stored(before), after, () => false);
    const ids = byQn(r.nodes);
    expect(ids.get('method A.run')).toBe(aRunBefore.id);
    expect(ids.get('method B.run')).not.toBe(aRunBefore.id);
    expect(new Set(ids.values()).size).toBe(r.nodes.length);
    expect(r.removed).toEqual([]);
  });

  test('a generated id held by a kept node is re-hashed, and edges follow the map', async () => {
    const before = await extract('a.ts', `export function run(): void {}\n`);
    const runBefore = before.find((n) => n.name === 'run')!;
    // A different function now sits on line 1 with the same kind+name: only
    // possible across scopes, so fake it by keeping the generated id.
    const fresh: Node[] = [
      before[0]!,
      { ...runBefore, qualifiedName: 'other.run', startLine: 1 },
      { ...runBefore, startLine: 3, id: 'function:moved' },
    ];
    const r = reconcileNodes(stored(before), fresh, () => false);
    expect(r.nodes[2]!.node.id).toBe(runBefore.id); // matched by (kind, qn)
    const other = r.nodes[1]!.node.id;
    expect(other).not.toBe(runBefore.id);
    expect(other).toMatch(/^function:[0-9a-f]{32}$/);
    expect(r.idMap.get(runBefore.id)).toBe(other);
    // Deterministic.
    expect(reconcileNodes(stored(before), fresh, () => false).nodes[1]!.node.id).toBe(other);
  });

  test('a dependency whose spec changed is matched by its stable id', async () => {
    const before = await extract(
      'package.json',
      JSON.stringify({ dependencies: { zod: '^3.22' } }),
    );
    const after = await extract('package.json', JSON.stringify({ dependencies: { zod: '^3.23' } }));
    const depBefore = before.find((n) => n.kind === 'declared-dependency')!;
    const depAfter = after.find((n) => n.kind === 'declared-dependency')!;
    expect(depAfter.qualifiedName).not.toBe(depBefore.qualifiedName);
    const r = reconcileNodes(stored(before), after, () => false);
    expect(r.removed).toEqual([]);
    expect(r.nodes.find((n) => n.node.kind === 'declared-dependency')!.storedId).toBe(depBefore.id);
  });

  test('removed symbols are reported and never re-used for new ones', async () => {
    const before = await extract(
      'a.ts',
      `export function gone(): void {}\nexport function kept(): void {}\n`,
    );
    const after = await extract(
      'a.ts',
      `export function kept(): void {}\nexport function added(): void {}\n`,
    );
    const r = reconcileNodes(stored(before), after, () => false);
    expect(r.removed.map((s) => s.qualifiedName)).toEqual(['gone']);
    const storedIds = new Set(before.map((n) => n.id));
    const added = r.nodes.find((n) => n.node.qualifiedName === 'added')!;
    expect(added.storedId).toBeNull();
    expect(storedIds.has(added.node.id)).toBe(false);
  });

  test('equal (kind, qualifiedName) pairs match by ordinal in position order', () => {
    const mk = (id: string, line: number): Node => ({
      id,
      kind: 'method',
      name: 'f',
      qualifiedName: 'A.f',
      filePath: 'a.py',
      language: 'python',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    });
    const old = [mk('method:first', 2), mk('method:second', 9)];
    const r = reconcileNodes(stored(old), [mk('method:x', 20), mk('method:y', 4)], () => false);
    // Position order: y (line 4) is ordinal 0, x (line 20) is ordinal 1.
    expect(r.nodes.map((n) => n.node.id)).toEqual(['method:second', 'method:first']);
  });

  test('ids taken elsewhere in the DB are avoided', async () => {
    const fresh = await extract('a.ts', `export function f(): void {}\n`);
    const f = fresh.find((n) => n.name === 'f')!;
    const r = reconcileNodes([], fresh, (id) => id === f.id);
    expect(r.nodes.find((n) => n.node.name === 'f')!.node.id).not.toBe(f.id);
  });
});
