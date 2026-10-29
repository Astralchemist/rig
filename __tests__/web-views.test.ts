// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';

// The endpoints the map's focused views read: hybrid search, node cards,
// neighbourhood, impact, critical path, overview, waypoints, orphans and
// the activity log. All additive; the older shapes are pinned in
// web-rest.test.ts.

const PORT = 7493;

describe('web view endpoints', () => {
  let project: string;
  let handle: WebHandle;
  let loginId: string;
  let renderId: string;
  let waypointId: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-web-views-'));
    writeFileSync(
      join(project, 'auth.ts'),
      `export function login(user: string): boolean { return !!user; }\n`,
    );
    writeFileSync(
      join(project, 'view.ts'),
      `import { login } from './auth.ts';\nexport function render(): void { login('x'); }\n`,
    );
    writeFileSync(join(project, 'gone.ts'), `export function doomed(): number { return 1; }\n`);
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    // serveWeb opens its own Rig: point it at the same embedder.
    writeFileSync(
      join(project, '.rig', 'config.json'),
      JSON.stringify({ embedder: { kind: 'deterministic' } }),
    );
    await rig.indexAll();
    const ctx = { sessionId: 'test', actor: 'ai:test' };
    loginId = rig.searchNodes('login')[0]!.id;
    renderId = rig.searchNodes('render')[0]!.id;
    rig.writes.annotateNode({ nodeId: loginId, note: 'keep it pure', rationale: 't' }, ctx);
    rig.writes.proposeEdge(
      {
        src: renderId,
        dst: loginId,
        kind: 'depends_on',
        rationale: 'calls it',
        sourceUrls: ['https://example.org/a'],
      },
      ctx,
    );
    waypointId = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Login is pure',
        summary: 'No side effects in login.',
        constellationRefs: [loginId],
        rationale: 't',
      },
      ctx,
    );
    rig.writes.dropWaypoint(
      {
        kind: 'observation',
        title: 'Render calls login',
        summary: 'Every render.',
        constellationRefs: [renderId],
        predecessors: [waypointId],
        rationale: 't',
      },
      ctx,
    );
    // Memory on a symbol that then disappears becomes an orphan.
    const doomed = rig.searchNodes('doomed')[0]!;
    rig.writes.annotateNode(
      { nodeId: doomed.id, note: 'outlives the symbol', rationale: 't' },
      ctx,
    );
    rmSync(join(project, 'gone.ts'));
    await rig.sync();
    await rig.whenIdle();
    rig.close();
    handle = await serveWeb({ projectRoot: project, port: PORT, watch: false });
  });

  afterAll(async () => {
    await handle.close();
    rmSync(project, { recursive: true, force: true });
  });

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
  const json = async <T>(path: string): Promise<T> => (await (await get(path)).json()) as T;

  test('GET /api/search stays a RigNode[] and adds score, matched_by and the mode header', async () => {
    const res = await get('/api/search?q=login');
    expect(res.status).toBe(200);
    expect(['hybrid', 'keyword-only']).toContain(res.headers.get('x-rig-search')!);
    const body = (await res.json()) as {
      id: string;
      name: string;
      type: string;
      data: unknown;
      score?: number;
      matched_by?: string[];
    }[];
    expect(Array.isArray(body)).toBe(true);
    const hit = body.find((n) => n.id === loginId)!;
    expect(hit.name).toBe('login');
    expect(hit.type).toBe('function');
    expect(typeof hit.data).toBe('object');
    expect(hit.matched_by).toContain('name');
  });

  test('GET /api/search?mode=keyword is the old keyword search', async () => {
    const res = await get('/api/search?q=login&mode=keyword');
    expect(res.headers.get('x-rig-search')).toBe('keyword');
    const body = (await res.json()) as { id: string }[];
    expect(body.some((n) => n.id === loginId)).toBe(true);
  });

  test('GET /api/graph nodes carry file_path', async () => {
    const g = await json<{ nodes: { id: string; file_path: string | null }[] }>('/api/graph');
    expect(g.nodes.find((n) => n.id === loginId)?.file_path).toBe('auth.ts');
  });

  test('GET /api/node/:id adds card, annotations and aliases', async () => {
    const n = await json<{
      card: { annotations: number; waypoints: number; file: string; line: number };
      annotations: { note: string }[];
      aliases: unknown[];
    }>(`/api/node/${encodeURIComponent(loginId)}`);
    expect(n.card.file).toBe('auth.ts');
    expect(n.card.line).toBe(1);
    expect(n.card.annotations).toBe(1);
    expect(n.card.waypoints).toBe(1);
    expect(n.annotations.map((a) => a.note)).toEqual(['keep it pure']);
    expect(Array.isArray(n.aliases)).toBe(true);
  });

  test('GET /api/cards returns cards in the order asked and skips unknown ids', async () => {
    const cards = await json<{ id: string }[]>(
      `/api/cards?ids=${encodeURIComponent(renderId)},nope,${encodeURIComponent(loginId)}`,
    );
    expect(cards.map((c) => c.id)).toEqual([renderId, loginId]);
    expect((await get('/api/cards')).status).toBe(400);
  });

  test('GET /api/node/:id/neighborhood has structural, pending and waypoint edges with cards', async () => {
    const h = await json<{
      center: { id: string };
      nodes: { id: string; kind: string }[];
      edges: { table: string; kind: string; pending_id?: number; source_urls?: string[] }[];
    }>(`/api/node/${encodeURIComponent(loginId)}/neighborhood`);
    expect(h.center.id).toBe(loginId);
    const pending = h.edges.find((e) => e.table === 'pending')!;
    expect(pending.kind).toBe('depends_on');
    expect(typeof pending.pending_id).toBe('number');
    expect(pending.source_urls).toEqual(['https://example.org/a']);
    expect(h.edges.some((e) => e.kind === 'waypoint_references')).toBe(true);
    expect(h.nodes.some((c) => c.kind === 'conversation-waypoint')).toBe(true);
    expect((await get('/api/node/nope/neighborhood')).status).toBe(404);
  });

  test('GET /api/node/:id/impact returns a tree of dependents', async () => {
    const t = await json<{
      root: { id: string };
      nodes: { id: string; depth: number }[];
      edges: { src: string; dst: string; kind: string }[];
    }>(`/api/node/${encodeURIComponent(loginId)}/impact?depth=2`);
    expect(t.root.id).toBe(loginId);
    const render = t.nodes.find((n) => n.id === renderId);
    expect(render?.depth).toBe(1);
    expect(t.edges.some((e) => e.src === loginId && e.dst === renderId)).toBe(true);
    // Waypoint anchors are memory, not dependents.
    expect(t.nodes.some((n) => n.id.startsWith('waypoint:'))).toBe(false);
  });

  test('GET /api/node/:id/critical-path returns steps with cards', async () => {
    const p = await json<{ path: { id: string; card: { id: string } | null }[] }>(
      `/api/node/${encodeURIComponent(renderId)}/critical-path`,
    );
    expect(p.path[0]?.id).toBe(renderId);
    expect(p.path[0]?.card?.id).toBe(renderId);
  });

  test('GET /api/overview is the orientation map', async () => {
    const o = await json<{ map: string; generated_at: number; nodes: number; est_tokens: number }>(
      '/api/overview',
    );
    expect(o.map).toContain('# Repository overview');
    expect(o.nodes).toBeGreaterThan(0);
    expect(o.est_tokens).toBeGreaterThan(0);
  });

  test('GET /api/waypoints lists, filters by kind, and searches', async () => {
    const all = await json<{ waypoints: { id: string; kind: string }[] }>('/api/waypoints');
    expect(all.waypoints).toHaveLength(2);
    const decisions = await json<{ waypoints: { kind: string }[] }>('/api/waypoints?kind=decision');
    expect(decisions.waypoints.map((w) => w.kind)).toEqual(['decision']);
    expect((await get('/api/waypoints?kind=bogus')).status).toBe(400);
    const found = await json<{ waypoints: { title: string }[] }>('/api/waypoints?q=render');
    expect(found.waypoints[0]?.title).toBe('Render calls login');
  });

  test('GET /api/waypoints/:id returns the chain and the anchored cards', async () => {
    const list = await json<{ waypoints: { id: string; title: string }[] }>('/api/waypoints');
    const second = list.waypoints.find((w) => w.title === 'Render calls login')!;
    const d = await json<{
      waypoint: { id: string };
      chain: { id: string }[];
      refs: { id: string }[];
    }>(`/api/waypoints/${encodeURIComponent(second.id)}`);
    expect(d.waypoint.id).toBe(second.id);
    expect(d.chain.map((w) => w.id)).toContain(waypointId);
    expect(d.refs.map((c) => c.id).sort()).toEqual([loginId, renderId].sort());
    expect((await get('/api/waypoints/nope')).status).toBe(404);
  });

  test('GET /api/orphans lists detached memory with what is waiting', async () => {
    const o = await json<{
      orphans: { name: string; reason: string; memory: { annotations: number }; notes: string[] }[];
    }>('/api/orphans');
    const row = o.orphans.find((x) => x.name === 'doomed')!;
    expect(row.reason).toBe('file-deleted');
    expect(row.memory.annotations).toBe(1);
    expect(row.notes).toEqual(['outlives the symbol']);
    const status = await json<{ orphans: number }>('/api/status');
    expect(status.orphans).toBe(o.orphans.length);
  });

  test('GET /api/activity shows writes and what the map would undo', async () => {
    const before = await json<{ next_undo: unknown; items: { kind: string; undone: boolean }[] }>(
      '/api/activity',
    );
    expect(before.items.some((i) => i.kind === 'drop_waypoint')).toBe(true);
    // Nothing the map (session 'web') wrote yet.
    expect(before.next_undo).toBeNull();
    const pending = (await json<{ id: number }[]>('/api/pending-edges'))[0]!;
    const accept = await fetch(`http://127.0.0.1:${PORT}/api/pending-edges/${pending.id}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(accept.ok).toBe(true);
    const after = await json<{ next_undo: { kind: string } | null }>('/api/activity');
    expect(after.next_undo?.kind).toBe('accept_edge');
    await fetch(`http://127.0.0.1:${PORT}/api/undo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}` },
    });
    const undone = await json<{ next_undo: unknown; items: { kind: string; undone: boolean }[] }>(
      '/api/activity',
    );
    expect(undone.items.find((i) => i.kind === 'accept_edge')?.undone).toBe(true);
  });

  test('the new endpoints need the token like the rest', async () => {
    for (const path of [
      '/api/overview',
      '/api/waypoints',
      '/api/orphans',
      '/api/activity',
      `/api/cards?ids=${loginId}`,
    ]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      expect(res.status).toBe(401);
    }
  });
});
