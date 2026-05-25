// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';

describe('extractor: type references + contains edges', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-typeref-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test('interface used as a parameter type generates a references edge', async () => {
    writeFileSync(
      join(project, 'types.ts'),
      `export interface MutationRow { id: number; kind: string; }`,
    );
    writeFileSync(
      join(project, 'use.ts'),
      `import type { MutationRow } from './types.ts';
export function handle(m: MutationRow): number { return m.id; }`,
    );
    const rig = await Rig.init(project);
    await rig.indexAll();

    const mr = rig.searchNodes('MutationRow').find((n) => n.name === 'MutationRow');
    expect(mr).toBeDefined();
    const neighbors = rig.getNeighbors(mr!.id);
    expect(neighbors.length).toBeGreaterThan(0);

    const incomingRefs = neighbors.filter((e) => e.kind === 'references' && e.dst === mr!.id);
    expect(incomingRefs.length).toBeGreaterThan(0);
    rig.close();
  });

  test('every declaration gets a `contains` edge from its parent scope', async () => {
    writeFileSync(
      join(project, 'a.ts'),
      `export class Outer {
  inner(): number { return 1; }
}
export interface Shape { x: number; }`,
    );
    const rig = await Rig.init(project);
    await rig.indexAll();

    const outer = rig.searchNodes('Outer').find((n) => n.name === 'Outer');
    const inner = rig.searchNodes('inner').find((n) => n.name === 'inner');
    const shape = rig.searchNodes('Shape').find((n) => n.name === 'Shape');
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(shape).toBeDefined();

    // file → Outer (contains), Outer → inner (contains), file → Shape (contains)
    const outerNbrs = rig.getNeighbors(outer!.id);
    expect(outerNbrs.some((e) => e.kind === 'contains' && e.dst === outer!.id)).toBe(true);
    expect(outerNbrs.some((e) => e.kind === 'contains' && e.src === outer!.id && e.dst === inner!.id)).toBe(true);
    const shapeNbrs = rig.getNeighbors(shape!.id);
    expect(shapeNbrs.some((e) => e.kind === 'contains' && e.dst === shape!.id)).toBe(true);
    rig.close();
  });

  test('extends clause produces an `extends` edge', async () => {
    writeFileSync(
      join(project, 'a.ts'),
      `export class Base { do(): void {} }
export class Child extends Base { extra(): void {} }`,
    );
    const rig = await Rig.init(project);
    await rig.indexAll();

    const base = rig.searchNodes('Base').find((n) => n.name === 'Base' && n.type === 'class');
    const child = rig.searchNodes('Child').find((n) => n.name === 'Child' && n.type === 'class');
    expect(base).toBeDefined();
    expect(child).toBeDefined();
    const nbrs = rig.getNeighbors(child!.id);
    expect(nbrs.some((e) => e.kind === 'extends' && e.src === child!.id && e.dst === base!.id)).toBe(true);
    rig.close();
  });
});
