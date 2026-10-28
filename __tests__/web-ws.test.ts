// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import nodeAnnotated from '../.contracts/events/node-annotated.contract.ts';
import waypointDropped from '../.contracts/events/waypoint-dropped.contract.ts';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';
import { deriveEvents } from '../packages/web/src/ws-derive.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const initProject = async (): Promise<string> => {
  const project = mkdtempSync(join(tmpdir(), 'rig-web-ws-'));
  const rig = await Rig.init(project);
  rig.close();
  return project;
};

const openWs = async (handle: WebHandle): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(handle.url).port}/ws`, {
    headers: { authorization: `Bearer ${handle.token}` },
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return ws;
};

// Fail fast with a clear message instead of letting a hung close() run into
// the test timeout (#3).
const closeWithin = async (handle: WebHandle, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`close() still pending after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([handle.close(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

describe('web WS channel', () => {
  test(
    'client receives hello + db:changed on index',
    async () => {
      const project = mkdtempSync(join(tmpdir(), 'rig-web-ws-'));
      const rig0 = await Rig.init(project);
      rig0.close();
      const handle = await serveWeb({ projectRoot: project, port: 0 });
      const port = new URL(handle.url).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      const events: Array<{ type: string }> = [];
      ws.on('message', (m) => events.push(JSON.parse(m.toString()) as { type: string }));
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      await sleep(50);
      expect(events.some((e) => e.type === 'hello')).toBe(true);

      writeFileSync(join(project, 'live.ts'), 'export const live = 1;');
      const rig = await Rig.open(project);
      await rig.indexAll();
      rig.close();
      await sleep(500);
      expect(events.some((e) => e.type === 'db:changed')).toBe(true);

      ws.terminate();
      await handle.close();
      rmSync(project, { recursive: true, force: true });
    },
    15000,
  );
});

describe('web WS live updates', () => {
  test('broadcasts one event per write, for every write after startup', async () => {
    const project = await initProject();
    const handle = await serveWeb({ projectRoot: project, port: 0 });
    const events: Array<{ type: string }> = [];
    const ws = await openWs(handle);
    ws.on('message', (m) => events.push(JSON.parse(m.toString()) as { type: string }));
    const selections = (): number => events.filter((e) => e.type === 'selection:changed').length;

    // Every write appends to the same open WAL in place; macOS's fs.watch
    // reports only the first of those, so writes 2 and 3 are the real check.
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${handle.url}/api/selection`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${handle.token}`,
        },
        body: JSON.stringify({ node_id: null }),
      });
      expect(res.ok).toBe(true);
      const deadline = Date.now() + 2000;
      while (selections() < i && Date.now() < deadline) await sleep(25);
      expect(selections()).toBe(i);
    }
    // ...and no duplicates trail in once the debounce and poll have settled.
    await sleep(600);
    expect(selections()).toBe(3);

    ws.terminate();
    await handle.close();
    rmSync(project, { recursive: true, force: true });
  });
});

describe('WebHandle.close() (#3)', () => {
  test('resolves with a WS client still connected, and drops that client', async () => {
    const project = await initProject();
    const handle = await serveWeb({ projectRoot: project, port: 0 });
    const ws = await openWs(handle);
    const dropped = new Promise<void>((res) => ws.once('close', () => res()));

    await closeWithin(handle, 2000);
    await dropped;
    rmSync(project, { recursive: true, force: true });
  });

  test('resolves with a half-sent HTTP request open', async () => {
    const project = await initProject();
    const handle = await serveWeb({ projectRoot: project, port: 0 });
    const sock = connect(Number(new URL(handle.url).port), '127.0.0.1');
    await new Promise<void>((res, rej) => {
      sock.once('connect', () => res());
      sock.once('error', rej);
    });
    sock.on('error', () => {}); // the server resets it on close
    // Headers never terminated: the server sees an active (not idle) request.
    sock.write('GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await sleep(50);

    await closeWithin(handle, 2000);
    sock.destroy();
    rmSync(project, { recursive: true, force: true });
  });
});

describe('WS events for waypoints and annotations', () => {
  const ctx = { sessionId: 'agent-1', actor: 'ai:test' };

  // A project with one function, a waypoint referencing it and a note on it.
  const seed = async (rig: Rig): Promise<{ helper: string; waypoint: string }> => {
    await rig.indexAll();
    const helper = rig.searchNodes('helper').find((n) => n.type === 'function')!.id;
    const waypoint = rig.writes.dropWaypoint(
      {
        kind: 'decision',
        title: 'Route through helper',
        summary: 'All doubling goes through helper',
        constellationRefs: [helper],
      },
      ctx,
    );
    rig.writes.annotateNode({ nodeId: helper, note: 'auth boundary', rationale: 'note it' }, ctx);
    return { helper, waypoint };
  };
  const newProject = (): string => {
    const project = mkdtempSync(join(tmpdir(), 'rig-web-ws-'));
    writeFileSync(join(project, 'b.ts'), 'export function helper(): number { return 2; }\n');
    return project;
  };

  test('deriveEvents maps drop_waypoint and annotate to their event contracts', async () => {
    const project = newProject();
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    try {
      const { helper, waypoint } = await seed(rig);
      const events = deriveEvents(rig, rig.writes.mutationsSince(0));
      const dropped = events.find((e) => e.type === 'waypoint:dropped');
      expect(waypointDropped.payload.parse(dropped?.payload)).toEqual({
        id: waypoint,
        kind: 'decision',
        title: 'Route through helper',
        session_id: 'agent-1',
        constellation_refs: [helper],
        predecessors: [],
      });
      const annotated = events.find((e) => e.type === 'node:annotated');
      expect(nodeAnnotated.payload.parse(annotated?.payload)).toEqual({
        node_id: helper,
        annotation_id: rig.getAnnotations(helper)[0]!.id,
        note: 'auth boundary',
      });

      // Undone before the bus read it: nothing to show.
      rig.writes.undoLast(ctx);
      rig.writes.undoLast(ctx);
      const after = deriveEvents(rig, rig.writes.mutationsSince(0)).map((e) => e.type);
      expect(after).not.toContain('waypoint:dropped');
      expect(after).not.toContain('node:annotated');
    } finally {
      rig.close();
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('the live map receives waypoint:dropped and node:annotated', async () => {
    const project = newProject();
    const init = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await init.indexAll();
    init.close();
    const handle = await serveWeb({ projectRoot: project, port: 0, watch: false });
    const events: Array<{ type: string; payload?: unknown }> = [];
    const ws = await openWs(handle);
    ws.on('message', (m) => events.push(JSON.parse(m.toString()) as { type: string }));

    // Another process (an agent's MCP server) writes to the same database.
    const agent = await Rig.open(project, { embedder: new DeterministicEmbedder() });
    const { helper, waypoint } = await seed(agent);
    agent.close();

    const has = (type: string): boolean => events.some((e) => e.type === type);
    const deadline = Date.now() + 3000;
    while (!(has('waypoint:dropped') && has('node:annotated')) && Date.now() < deadline) {
      await sleep(25);
    }
    expect(events.find((e) => e.type === 'waypoint:dropped')?.payload).toMatchObject({
      id: waypoint,
      constellation_refs: [helper],
    });
    expect(events.find((e) => e.type === 'node:annotated')?.payload).toMatchObject({
      node_id: helper,
      note: 'auth boundary',
    });

    ws.terminate();
    await handle.close();
    rmSync(project, { recursive: true, force: true });
  });
});
