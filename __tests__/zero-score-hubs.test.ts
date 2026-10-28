// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { recomputeHubness } from '@rig/core/graph/hubness.ts';

interface HubRow {
  id: string;
  type: string;
  name: string;
  is_hub: number;
  hubness: number;
}

// Hubs are the top 5% of each anchor type (at least one). A type where every
// member scores 0 — no `contains` fanout, no heat — has no real hub, so the
// "top" member was an arbitrary tie that still collected rig_pull's hub bonus.
describe('zero-score hubs', () => {
  let project: string;
  let rig: Rig;
  const ctx = { sessionId: 'test', actor: 'ai:test' };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-zero-hub-'));
    writeFileSync(
      join(project, 'auth.ts'),
      `export class AuthStore {
  login(): void {
    this.record();
  }
  record(): void {}
}
export function helper(): void {}
`,
    );
    writeFileSync(join(project, 'README.md'), '# Title\n\nIntro.\n\n## Install\n\nRun it.\n\n## Usage\n\nUse it.\n');
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { zod: '^3.23.0', fastify: '^5.0.0' } }),
    );
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.writes.dropWaypoint({ kind: 'decision', title: 'Use zod', summary: 'Validate inputs with zod' }, ctx);
    recomputeHubness(rig.database.adapter);
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const rows = (): HubRow[] =>
    rig.database.adapter
      .prepare(`SELECT id, type, name, is_hub, hubness FROM nodes`)
      .all() as HubRow[];

  test('a type whose members all score 0 gets no hub', () => {
    const all = rows();
    for (const type of ['markdown-section', 'declared-dependency', 'conversation-waypoint']) {
      const members = all.filter((r) => r.type === type);
      expect(members.length).toBeGreaterThan(0);
      expect(members.every((r) => r.hubness === 0)).toBe(true);
      expect(members.filter((r) => r.is_hub === 1).map((r) => r.name)).toEqual([]);
    }
    expect(all.filter((r) => r.is_hub === 1 && r.hubness <= 0).map((r) => r.name)).toEqual([]);
  });

  test('types with real fanout still get their hub', () => {
    const hubs = rows()
      .filter((r) => r.is_hub === 1)
      .map((r) => r.name);
    expect(hubs).toContain('AuthStore');
    expect(hubs).toContain('auth.ts');
  });

  test('an explicit promote still makes a zero-fanout node a hub', () => {
    const zod = rows().find((r) => r.type === 'declared-dependency' && r.name === 'zod')!;
    expect(rig.writes.promoteHub(zod.id, 'core validation library', ctx)).toBe(true);
    recomputeHubness(rig.database.adapter);
    const after = rows().find((r) => r.id === zod.id)!;
    expect(after.is_hub).toBe(1);
    expect(after.hubness).toBeGreaterThan(0);
  });

  test('rig_pull gives zero-score nodes no hub bonus', () => {
    const all = rows();
    const anchor = all.find((r) => r.name === 'AuthStore')!;
    const zeroIds = new Set(all.filter((r) => r.hubness === 0).map((r) => r.id));
    const zero = rig.getMagneticPull(anchor.id, 100).filter((r) => zeroIds.has(r.nodeId));
    expect(zero.length).toBeGreaterThan(0);
    for (const r of zero) expect(r.components.hub).toBe(0);
  });
});
