import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 3.5 A1 — hub-and-spoke topology.
describe('A1 hubs', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-hubs-'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const seed = async (): Promise<Rig> => {
    // hub.ts contains many exports; leaf files contain one each. Files are
    // structural hubs because they emit many `contains` edges to their members.
    writeFileSync(
      join(project, 'hub.ts'),
      `
      export function a(): void {}
      export function b(): void {}
      export function c(): void {}
      export function d(): void {}
      export function e(): void {}
      export function f(): void {}
      `,
    );
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(project, `leaf${i}.ts`), `export function leaf${i}(): void {}\n`);
    }
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    return rig;
  };

  test('hubness column populated and is_hub flagged for top fanout', async () => {
    const rig = await seed();
    const row = rig.database.adapter
      .prepare(`SELECT id, is_hub, hubness FROM nodes WHERE name = 'hub.ts' LIMIT 1`)
      .get() as { id: string; is_hub: number; hubness: number } | null;
    expect(row).not.toBeNull();
    expect(row!.is_hub).toBe(1);
    expect(row!.hubness).toBeGreaterThan(0);
    rig.close();
  });

  test('rig_hubs returns top hubs ranked by hubness', async () => {
    const rig = await seed();
    const hubs = rig.getTopHubs({ limit: 5 });
    expect(hubs.length).toBeGreaterThan(0);
    // Hubness should be non-increasing.
    for (let i = 1; i < hubs.length; i++) {
      expect(hubs[i - 1]!.hubness).toBeGreaterThanOrEqual(hubs[i]!.hubness);
    }
    rig.close();
  });

  test('rig_promote sets is_hub + hub_explicit and broadcasts via mutation_log', async () => {
    const rig = await seed();
    const leaf = rig.searchNodes('leaf0').find((n) => n.type === 'function');
    expect(leaf).toBeDefined();
    const before = rig.database.adapter
      .prepare(`SELECT is_hub, hub_explicit FROM nodes WHERE id = ?`)
      .get(leaf!.id) as { is_hub: number; hub_explicit: number };
    expect(before.is_hub).toBe(0);

    const ok = rig.writes.promoteHub(leaf!.id, 'explicitly marked for test', {
      sessionId: 'test',
      actor: 'user:test',
    });
    expect(ok).toBe(true);

    const after = rig.database.adapter
      .prepare(`SELECT is_hub, hub_explicit FROM nodes WHERE id = ?`)
      .get(leaf!.id) as { is_hub: number; hub_explicit: number };
    expect(after.is_hub).toBe(1);
    expect(after.hub_explicit).toBe(1);

    const mut = rig.database.adapter
      .prepare(`SELECT kind FROM mutation_log WHERE session_id = 'test' ORDER BY ts DESC LIMIT 1`)
      .get() as { kind: string };
    expect(mut.kind).toBe('promote_hub');
    rig.close();
  });

  test('rig_hub_of returns the structural hub a node belongs to', async () => {
    const rig = await seed();
    const fn = rig.searchNodes('a').find((n) => n.type === 'function');
    expect(fn).toBeDefined();
    const hubs = rig.getHubsOf(fn!.id, 3);
    // The hub.ts file should appear since it `contains` fn 'a'.
    expect(hubs.some((h) => h.name === 'hub.ts')).toBe(true);
    rig.close();
  });

  test('rig_drill from a file hub returns descendants ranked by pull', async () => {
    const rig = await seed();
    const file = rig
      .searchNodes('hub.ts')
      .find((n) => n.type === 'file' || n.name.endsWith('.ts'));
    expect(file).toBeDefined();
    const results = rig.drillFromHub(file!.id, { limit: 20 });
    // Should contain at least the 6 exported functions a..f
    const names = new Set(results.map((r) => r.name));
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(names.has(n)).toBe(true);
    }
    rig.close();
  });
});
