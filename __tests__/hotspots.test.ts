import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { recordActivation } from '@rig/core/db/activation-queries.ts';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 3.5 C1 — hot-node tracking.
describe('C1 rig_hotspots + rig_cold', () => {
  let project: string;
  let rig: Rig;
  let alphaId: string;
  let betaId: string;
  let gammaId: string;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-hot-'));
    writeFileSync(join(project, 'a.ts'), `export function alpha(): void {}\n`);
    writeFileSync(join(project, 'b.ts'), `export function beta(): void {}\n`);
    writeFileSync(join(project, 'c.ts'), `export function gamma(): void {}\n`);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    alphaId = rig.searchNodes('alpha').find((n) => n.type === 'function')!.id;
    betaId = rig.searchNodes('beta').find((n) => n.type === 'function')!.id;
    gammaId = rig.searchNodes('gamma').find((n) => n.type === 'function')!.id;
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('hotspots rank by recent touch count', () => {
    for (let i = 0; i < 5; i++) recordActivation(rig.database.adapter, alphaId, 'mcp');
    for (let i = 0; i < 2; i++) recordActivation(rig.database.adapter, betaId, 'mcp');

    const hot = rig.getHotspots();
    expect(hot.length).toBe(2);
    expect(hot[0]!.id).toBe(alphaId);
    expect(hot[0]!.touches).toBe(5);
    expect(hot[1]!.id).toBe(betaId);
    expect(hot[1]!.touches).toBe(2);
  });

  test('hotspots count distinct sessions', () => {
    recordActivation(rig.database.adapter, alphaId, 'mcp', { sessionId: 's1' });
    recordActivation(rig.database.adapter, alphaId, 'mcp', { sessionId: 's1' });
    recordActivation(rig.database.adapter, alphaId, 'mcp', { sessionId: 's2' });
    recordActivation(rig.database.adapter, betaId, 'mcp', { sessionId: 's1' });
    recordActivation(rig.database.adapter, betaId, 'mcp', { sessionId: 's2' });
    recordActivation(rig.database.adapter, betaId, 'mcp', { sessionId: 's3' });

    const hot = rig.getHotspots();
    const byId = new Map(hot.map((h) => [h.id, h]));
    expect(byId.get(alphaId)!.unique_sessions).toBe(2);
    expect(byId.get(betaId)!.unique_sessions).toBe(3);
  });

  test('hotspots respect the window', () => {
    const now = Date.now();
    const old = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    rig.database.adapter
      .prepare(`INSERT INTO activations (node_id, ts, source) VALUES (?, ?, 'mcp')`)
      .run(alphaId, old);
    recordActivation(rig.database.adapter, betaId, 'mcp');

    const hot7d = rig.getHotspots({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(hot7d.length).toBe(1);
    expect(hot7d[0]!.id).toBe(betaId);

    const hot60d = rig.getHotspots({ windowMs: 60 * 24 * 60 * 60 * 1000 });
    expect(hot60d.length).toBe(2);
  });

  test('cold returns nodes never touched', () => {
    recordActivation(rig.database.adapter, alphaId, 'mcp');
    // beta + gamma never touched

    const cold = rig.getCold();
    const ids = new Set(cold.map((c) => c.id));
    expect(ids.has(betaId)).toBe(true);
    expect(ids.has(gammaId)).toBe(true);
    expect(ids.has(alphaId)).toBe(false);
    // last_ts is null for never-touched nodes
    expect(cold.find((c) => c.id === betaId)!.last_ts).toBeNull();
  });

  test('cold respects the stale-after threshold', () => {
    const now = Date.now();
    const old = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    rig.database.adapter
      .prepare(`INSERT INTO activations (node_id, ts, source) VALUES (?, ?, 'mcp')`)
      .run(alphaId, old);
    recordActivation(rig.database.adapter, betaId, 'mcp'); // now

    const cold90d = rig.getCold({ staleAfterMs: 90 * 24 * 60 * 60 * 1000 });
    const coldIds = new Set(cold90d.map((c) => c.id));
    // alpha touched 100d ago — cold under 90d threshold
    expect(coldIds.has(alphaId)).toBe(true);
    // beta touched recently — not cold
    expect(coldIds.has(betaId)).toBe(false);
  });
});
