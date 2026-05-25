// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@rig/core/db/database.ts';
import { upsertNode } from '@rig/core/db/node-queries.ts';
import { computeMagneticPull } from '@rig/core/pull.ts';
import { promoteHub } from '@rig/core/graph/hubness.ts';
import type { Node } from '@rig/core/extract/upstream-types.ts';

const mkNode = (id: string, name: string): Node => ({
  id,
  kind: 'function',
  name,
  qualifiedName: name,
  filePath: 'fixture.ts',
  language: 'typescript',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 0,
  updatedAt: Date.now(),
});

// Phase 3.5 D2 — hub-aware rig_pull reranking.
describe('D2 hub bias', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-d2-'));
    db = Database.open(join(dir, 'rig.db'));
    db.adapter.transaction(() => {
      // A is the anchor. B is a distant hub. C is a directly-called sub-node.
      upsertNode(db.adapter, mkNode('A', 'A'));
      upsertNode(db.adapter, mkNode('B', 'B'));
      upsertNode(db.adapter, mkNode('C', 'C'));
      db.adapter
        .prepare('INSERT INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('A', 'C', 'calls', 'ast', Date.now());
      // No edge A→B, so B's structural distance is unbounded.
    })();
    promoteHub(db.adapter, 'B');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('no hub bias: directly-called C outranks distant hub B', () => {
    const results = computeMagneticPull('A', ['B', 'C'], { db: db.adapter });
    expect(results[0]!.nodeId).toBe('C');
    expect(results[1]!.nodeId).toBe('B');
    // hub component is recorded even when bias is 0
    const b = results.find((r) => r.nodeId === 'B')!;
    expect(b.components.hub).toBe(1);
  });

  test('hubBias=0.5: hub B leapfrogs the directly-called C', () => {
    const results = computeMagneticPull(
      'A',
      ['B', 'C'],
      { db: db.adapter, hubBias: 0.5 },
    );
    expect(results[0]!.nodeId).toBe('B');
    expect(results[1]!.nodeId).toBe('C');
  });

  test('hub component is 0 for non-hubs, 1 for hubs', () => {
    const results = computeMagneticPull('A', ['B', 'C'], { db: db.adapter, hubBias: 0.3 });
    const b = results.find((r) => r.nodeId === 'B')!;
    const c = results.find((r) => r.nodeId === 'C')!;
    expect(b.components.hub).toBe(1);
    expect(c.components.hub).toBe(0);
  });

  test('score includes hubBias contribution', () => {
    const noBias = computeMagneticPull('A', ['B'], { db: db.adapter });
    const withBias = computeMagneticPull('A', ['B'], { db: db.adapter, hubBias: 0.4 });
    expect(withBias[0]!.score - noBias[0]!.score).toBeCloseTo(0.4, 5);
  });
});
