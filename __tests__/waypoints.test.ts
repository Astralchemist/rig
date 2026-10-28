// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { ToolError, type ToolContext } from '@rig/mcp/dispatch.ts';
import { rigChainHandler } from '../generated/mcp/handlers/rig_chain.handler.ts';
import { rigDropWaypointHandler } from '../generated/mcp/handlers/rig_drop_waypoint.handler.ts';
import { rigWaypointsHandler } from '../generated/mcp/handlers/rig_waypoints.handler.ts';

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

  test('session_id="last" resolves to the most-recently-active session', async () => {
    rig.writes.dropWaypoint(
      { kind: 'decision', title: 'first-session-decision', summary: 'in older session' },
      { sessionId: 'older', actor: 'ai:test' },
    );
    // Force a measurable time gap so last_seen for 'newer' is strictly later.
    await new Promise((r) => setTimeout(r, 5));
    rig.writes.dropWaypoint(
      { kind: 'decision', title: 'second-session-decision', summary: 'in newer session' },
      { sessionId: 'newer', actor: 'ai:test' },
    );
    const last = rig.getWaypoints({ sessionId: 'last', limit: 20 });
    expect(last.length).toBe(1);
    expect(last[0]!.session_id).toBe('newer');
    expect(last[0]!.title).toBe('second-session-decision');
  });

  test('session_id="last" returns empty when no sessions exist', () => {
    const result = rig.getWaypoints({ sessionId: 'last' });
    expect(result).toEqual([]);
  });

  test('B2 — payloads round-trip through drop + list', () => {
    const id = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'with payloads',
        summary: 'multimodal carrier',
        payloads: [
          { type: 'text-summary', content: 'short prose' },
          {
            type: 'mermaid-diagram',
            content: 'graph TD; A-->B',
          },
          { type: 'code-snippet', lang: 'ts', content: 'const x: number = 1;' },
          { type: 'doc-fragment', content: '## Decision\n...' },
          { type: 'image-ref', path: '.rig/media/diagram.svg', alt: 'arch' },
        ],
      },
      { sessionId: 'pay-test', actor: 'ai:test' },
    );
    const wp = rig.getWaypoints({ sessionId: 'pay-test' })[0]!;
    expect(wp.id).toBe(id);
    expect(wp.payloads.length).toBe(5);
    expect(wp.payloads[0]).toEqual({ type: 'text-summary', content: 'short prose' });
    const code = wp.payloads.find((p) => p.type === 'code-snippet');
    expect(code).toMatchObject({ lang: 'ts', content: 'const x: number = 1;' });
    const img = wp.payloads.find((p) => p.type === 'image-ref');
    expect(img).toMatchObject({ path: '.rig/media/diagram.svg', alt: 'arch' });
  });

  test('B2 — waypoints without payloads carry an empty array', () => {
    const id = rig.writes.dropWaypoint(
      { kind: 'observation', title: 'plain', summary: 'no payloads here' },
      ctx,
    );
    const wp = rig.getWaypoints({ limit: 1 }).find((w) => w.id === id);
    expect(wp).toBeDefined();
    expect(wp!.payloads).toEqual([]);
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

describe('rig_drop_waypoint: rationale and references', () => {
  let project: string;
  let rig: Rig;
  let helper: string;

  const toolCtx = (sessionId = 'agent-1'): ToolContext => ({
    rig,
    sessionId,
    provenance: 'ai:test',
    recordActivation: () => {},
  });
  const drop = (extra: Record<string, unknown> = {}): Promise<unknown> =>
    rigDropWaypointHandler.run(
      {
        kind: 'decision',
        title: 'Route through helper',
        summary: 'All doubling goes through helper',
        rationale: 'the user asked for one entry point',
        ...extra,
      },
      toolCtx(),
    );
  const count = (sql: string): number =>
    (rig.database.adapter.prepare(sql).get() as { n: number }).n;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-wp-refs-'));
    writeFileSync(join(project, 'b.ts'), 'export function helper(): number { return 2; }\n');
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    helper = rig.searchNodes('helper').find((n) => n.type === 'function')!.id;
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('the rationale is stored and returned by rig_waypoints and rig_chain', async () => {
    const { id } = (await drop({ constellation_refs: [helper] })) as { id: string };
    const listed = (await rigWaypointsHandler.run({}, toolCtx())) as {
      waypoints: { id: string; rationale?: string }[];
    };
    expect(listed.waypoints).toEqual([
      expect.objectContaining({ id, rationale: 'the user asked for one entry point' }),
    ]);
    const chain = (await rigChainHandler.run({ id }, toolCtx())) as {
      chain: { id: string; rationale?: string }[];
    };
    expect(chain.chain[0]).toMatchObject({ id, rationale: 'the user asked for one entry point' });
  });

  test('unknown refs and predecessors fail with NODE_NOT_FOUND listing them; nothing is written', async () => {
    let caught: ToolError | null = null;
    try {
      await drop({
        constellation_refs: [helper, 'function:gone'],
        predecessors: ['waypoint:gone'],
      });
    } catch (e) {
      caught = e as ToolError;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught?.code).toBe('NODE_NOT_FOUND');
    expect(caught?.message).toContain('function:gone');
    expect(caught?.message).toContain('waypoint:gone');
    expect(caught?.data).toEqual({
      unknown_ids: ['function:gone', 'waypoint:gone'],
      constellation_refs: ['function:gone'],
      predecessors: ['waypoint:gone'],
    });
    expect(count(`SELECT COUNT(*) AS n FROM nodes WHERE type = 'conversation-waypoint'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM sessions`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM mutation_log`)).toBe(0);
  });

  test('a ref listed twice is one edge, not a constraint failure', async () => {
    await drop({ constellation_refs: [helper, helper] });
    expect(count(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'waypoint_references'`)).toBe(1);
  });
});

describe('rig_waypoints session_id="last"', () => {
  let project: string;
  let rig: Rig;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const dropIn = (sessionId: string, title: string): string =>
    rig.writes.dropWaypoint(
      { kind: 'decision', title, summary: `dropped in ${sessionId}` },
      { sessionId, actor: 'ai:test' },
    );
  // What `rig_waypoints session_id="last"` returns to the given MCP session.
  const lastFor = async (sessionId: string): Promise<string[]> => {
    const ctx: ToolContext = { rig, sessionId, provenance: 'ai:test', recordActivation: () => {} };
    const r = (await rigWaypointsHandler.run({ session_id: 'last', limit: 20 }, ctx)) as {
      waypoints: { title: string }[];
    };
    return r.waypoints.map((w) => w.title);
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-wp-last-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('a session that has not dropped waypoints gets the most recent session', async () => {
    dropIn('older', 'older decision');
    await sleep(5);
    dropIn('newer', 'newer decision');
    expect(await lastFor('fresh')).toEqual(['newer decision']);
  });

  test('a session that has dropped waypoints still gets the previous session, not its own', async () => {
    dropIn('previous', 'previous decision');
    await sleep(5);
    dropIn('current', 'my own decision');
    expect(await lastFor('current')).toEqual(['previous decision']);
    // Only the caller has waypoints: nothing from a previous session.
    expect(await lastFor('previous')).toEqual(['my own decision']);
  });

  test('skips a session whose waypoints were all undone', async () => {
    dropIn('older', 'older decision');
    await sleep(5);
    dropIn('newer', 'undone decision');
    rig.writes.undoLast({ sessionId: 'newer', actor: 'ai:test' });
    expect(await lastFor('fresh')).toEqual(['older decision']);
  });

  test('is empty when no other session has waypoints', async () => {
    dropIn('current', 'my own decision');
    expect(await lastFor('current')).toEqual([]);
  });
});
