import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

// Phase 4 B1 — conversation waypoints.
describe('B1 conversation waypoints', () => {
  let project: string;
  let rig: Rig;
  const ctx = { sessionId: 'test-session', actor: 'ai:test' };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-wp-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('drop creates a waypoint node + session row + mutation entry', () => {
    const id = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Lock TS + Bun as primary stack',
        summary: 'Bun runtime + bun:sqlite; better-sqlite3 fallback for Node ≥20',
        analogy: 'The Sovereign move',
        keyTerms: ['bun', 'sqlite'],
      },
      ctx,
    );
    expect(id.startsWith('waypoint:')).toBe(true);

    const node = rig.getNode(id);
    expect(node).toBeDefined();
    expect(node!.type).toBe('conversation-waypoint');
    expect(node!.name).toBe('Lock TS + Bun as primary stack');

    const wp = rig.getWaypoints({ limit: 1 })[0]!;
    expect(wp.id).toBe(id);
    expect(wp.kind).toBe('decision');
    expect(wp.session_id).toBe('test-session');
    expect(wp.analogy).toBe('The Sovereign move');
    expect(wp.key_terms).toEqual(['bun', 'sqlite']);

    const sess = rig.database.adapter
      .prepare(`SELECT id, started_at, last_seen FROM sessions WHERE id = ?`)
      .get('test-session') as { id: string; started_at: number; last_seen: number } | null;
    expect(sess).not.toBeNull();
    expect(sess!.last_seen).toBeGreaterThanOrEqual(sess!.started_at);

    const muts = rig.writes.mutationsSince(0, 'test-session');
    expect(muts.some((m) => m.kind === 'drop_waypoint')).toBe(true);
  });

  test('predecessors and constellation_refs create the right edges', () => {
    const wp1 = rig.writes.dropWaypoint(
      { kind: 'observation', title: 'first', summary: 'the first one' },
      ctx,
    );
    const wp2 = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'second',
        summary: 'follows the first',
        predecessors: [wp1],
      },
      ctx,
    );
    const succ = rig
      .getNeighbors(wp2)
      .filter((e) => e.kind === 'waypoint_succeeds');
    expect(succ.length).toBe(1);
    expect(succ[0]!.src).toBe(wp2);
    expect(succ[0]!.dst).toBe(wp1);
  });

  test('list filters by session and by kind, ordered newest-first', () => {
    rig.writes.dropWaypoint(
      { kind: 'decision', title: 'd1', summary: 'first decision' },
      ctx,
    );
    rig.writes.dropWaypoint(
      { kind: 'observation', title: 'o1', summary: 'first observation' },
      ctx,
    );
    rig.writes.dropWaypoint(
      { kind: 'decision', title: 'd2', summary: 'second decision' },
      { sessionId: 'other', actor: 'ai:test' },
    );

    const all = rig.getWaypoints();
    expect(all.length).toBe(3);
    // newest first
    expect(all[0]!.title).toBe('d2');

    const decisions = rig.getWaypoints({ kind: 'decision' });
    expect(decisions.length).toBe(2);
    expect(decisions.every((w) => w.kind === 'decision')).toBe(true);

    const onlyOurs = rig.getWaypoints({ sessionId: 'test-session' });
    expect(onlyOurs.length).toBe(2);
  });

  test('chain walks the predecessor links seed → ... → root', () => {
    const a = rig.writes.dropWaypoint(
      { kind: 'observation', title: 'root', summary: 'root' },
      ctx,
    );
    const b = rig.writes.dropWaypoint(
      { kind: 'observation', title: 'mid', summary: 'mid', predecessors: [a] },
      ctx,
    );
    const c = rig.writes.dropWaypoint(
      { kind: 'observation', title: 'leaf', summary: 'leaf', predecessors: [b] },
      ctx,
    );
    const chain = rig.getWaypointChain(c, 10);
    expect(chain.map((w) => w.id)).toEqual([c, b, a]);
  });

  test('undo reverses the waypoint drop', () => {
    const id = rig.writes.dropWaypoint(
      { kind: 'decision', title: 'will be undone', summary: 'oops' },
      { sessionId: 'undo-test', actor: 'ai:test' },
    );
    expect(rig.getNode(id)).toBeDefined();
    const undone = rig.writes.undoLast({ sessionId: 'undo-test', actor: 'ai:test' });
    expect(undone?.kind).toBe('drop_waypoint');
    expect(rig.getNode(id)).toBeNull();
  });
});
