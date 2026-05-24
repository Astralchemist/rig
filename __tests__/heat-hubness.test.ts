import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { recordActivation } from '@rig/core/db/activation-queries.ts';
import { recomputeHubness } from '@rig/core/graph/hubness.ts';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// C1 ↔ A1 — heat feeds the hubness score. Heavily-touched anchors gain
// hubness even at the same fanout as cold ones.
describe('C1 → A1 heat boosts hubness', () => {
  let project: string;
  let rig: Rig;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-heat-hub-'));
    // Two files of equal shape — equal fanout. Hubness should be equal
    // before any activations.
    writeFileSync(join(project, 'a.ts'), `export function f(): void {}\n`);
    writeFileSync(join(project, 'b.ts'), `export function g(): void {}\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('hot file pulls ahead of cold file in hubness after activations', () => {
    const aFile = rig.searchNodes('a.ts').find((n) => n.type === 'file')!;
    const bFile = rig.searchNodes('b.ts').find((n) => n.type === 'file')!;

    const before = rig.database.adapter
      .prepare(`SELECT id, hubness FROM nodes WHERE id IN (?, ?)`)
      .all(aFile.id, bFile.id) as { id: string; hubness: number }[];
    const beforeMap = new Map(before.map((r) => [r.id, r.hubness]));
    // Equal fanout → equal hubness before any activation
    expect(beforeMap.get(aFile.id)).toBeCloseTo(beforeMap.get(bFile.id)!, 5);

    for (let i = 0; i < 10; i++) recordActivation(rig.database.adapter, aFile.id, 'mcp');
    recomputeHubness(rig.database.adapter);

    const after = rig.database.adapter
      .prepare(`SELECT id, hubness FROM nodes WHERE id IN (?, ?)`)
      .all(aFile.id, bFile.id) as { id: string; hubness: number }[];
    const afterMap = new Map(after.map((r) => [r.id, r.hubness]));
    expect(afterMap.get(aFile.id)!).toBeGreaterThan(afterMap.get(bFile.id)!);
  });
});
