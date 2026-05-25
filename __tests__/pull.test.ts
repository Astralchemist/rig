// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@rig/core/db/database.ts';
import { upsertEmbedding } from '@rig/core/db/embed-queries.ts';
import { upsertNode } from '@rig/core/db/node-queries.ts';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { computeMagneticPull } from '@rig/core/pull.ts';
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

describe('computeMagneticPull — structural + semantic + recency blend', () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-pull-'));
    db = Database.open(join(dir, 'rig.db'));

    const embedder = new DeterministicEmbedder();
    const [vA, vB, vC] = await embedder.embed(['alpha apple', 'beta beach', 'alpha apple']);

    db.adapter.transaction(() => {
      upsertNode(db.adapter, mkNode('A', 'A'));
      upsertNode(db.adapter, mkNode('B', 'B'));
      upsertNode(db.adapter, mkNode('C', 'C'));
      // A → B is a direct call (structural distance = 1).
      // A and C have no edge between them (structural distance = ∞ within maxHops).
      db.adapter
        .prepare('INSERT INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('A', 'B', 'calls', 'ast', Date.now());
      // Embeddings: A and C have identical text → cosine 1 → semantic 1.
      // B has different text → cosine ~0 → semantic ~0.5.
      upsertEmbedding(db.adapter, 'A', embedder.model, vA!);
      upsertEmbedding(db.adapter, 'B', embedder.model, vB!);
      upsertEmbedding(db.adapter, 'C', embedder.model, vC!);
    })();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('default weights: direct call B outranks semantically-identical-but-distant C', () => {
    const results = computeMagneticPull('A', ['B', 'C'], { db: db.adapter });
    expect(results[0]!.nodeId).toBe('B');
    expect(results[1]!.nodeId).toBe('C');
  });

  it('with structural=0, semantic-only ranking flips C above B', () => {
    const results = computeMagneticPull('A', ['B', 'C'], { db: db.adapter }, {
      structural: 0,
      semantic: 1,
      recency: 0,
    });
    expect(results[0]!.nodeId).toBe('C');
    expect(results[1]!.nodeId).toBe('B');
  });

  it('returns components alongside the score', () => {
    const results = computeMagneticPull('A', ['B'], { db: db.adapter });
    const b = results[0]!;
    expect(b.components.structural).toBeCloseTo(0.5, 5); // distance 1 → 1/(1+1)
    expect(b.components.semantic).toBeGreaterThan(0); // not totally orthogonal
    expect(b.components.recency).toBe(0); // no activations recorded
  });

  it('candidates with no embedding fall back to semantic=0, not undefined', () => {
    db.adapter.prepare('DELETE FROM embeddings WHERE node_id = ?').run('B');
    const results = computeMagneticPull('A', ['B', 'C'], { db: db.adapter });
    const b = results.find((r) => r.nodeId === 'B')!;
    expect(b.components.semantic).toBe(0);
  });
});
