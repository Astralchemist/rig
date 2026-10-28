// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const initProject = async (): Promise<string> => {
  const project = mkdtempSync(join(tmpdir(), 'rig-web-ws-'));
  const rig = await Rig.init(project);
  rig.close();
  return project;
};

const openWs = async (handle: WebHandle): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(handle.url).port}/ws`);
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

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
