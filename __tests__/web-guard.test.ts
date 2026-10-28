// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { makeRequestGuard } from '../packages/web/src/request-guard.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';
import { tryWs } from './_try-ws.ts';

describe('web guard — Host allowlist + Origin check (DNS rebinding, CSRF)', () => {
  let project: string;
  let handle: WebHandle;
  let port: number;
  let own: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-guard-'));
    (await Rig.init(project, { embedder: new DeterministicEmbedder() })).close();
    // No token in play: these checks must hold on their own.
    handle = await serveWeb({ projectRoot: project, port: 0, auth: false });
    port = Number(new URL(handle.url).port);
    own = `127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await handle.close();
    rmSync(project, { recursive: true, force: true });
  });

  const get = (host: string, url = '/api/status') =>
    handle.app.inject({ method: 'GET', url, headers: { host } });
  const postUndo = (headers: Record<string, string>) =>
    handle.app.inject({ method: 'POST', url: '/api/undo', headers: { host: own, ...headers } });

  test('wrong Host → 403, on the API, /health and the UI shell alike', async () => {
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost']) {
      expect((await get(host)).statusCode).toBe(403);
    }
    expect((await get(`rebind.evil.example:${port}`, '/health')).statusCode).toBe(403);
    expect((await get(`rebind.evil.example:${port}`, '/')).statusCode).toBe(403);
  });

  test('loopback names on the bound port pass', async () => {
    for (const host of [own, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      expect((await get(host)).statusCode).toBe(200);
    }
  });

  test('foreign-Origin POST → 403; our own origin or no Origin passes', async () => {
    expect((await postUndo({ origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await postUndo({ origin: 'null' })).statusCode).toBe(403);
    // Another local server (say, a second project's map) is a foreign origin too.
    expect((await postUndo({ origin: `http://127.0.0.1:${port + 1}` })).statusCode).toBe(403);
    expect((await postUndo({ origin: `http://${own}` })).statusCode).toBe(200);
    expect((await postUndo({ origin: `http://localhost:${port}` })).statusCode).toBe(200);
    expect((await postUndo({})).statusCode).toBe(200);
  });

  test('foreign-Origin PUT /api/config → 403, nothing written', async () => {
    const res = await handle.app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { host: own, origin: 'http://evil.example' },
      payload: { port: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(project, '.rig', 'config.json'))).toBe(false);
  });

  test('CORS: other origins get no Access-Control headers; preflights fail', async () => {
    // Previously allowed regardless of our port — another rig map on 7474.
    for (const origin of ['http://127.0.0.1:7474', 'http://evil.example']) {
      const res = await handle.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { host: own, origin },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await handle.app.inject({
        method: 'OPTIONS',
        url: '/api/undo',
        headers: { host: own, origin, 'access-control-request-method': 'POST' },
      });
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
      expect(pre.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  test('foreign-Origin WS upgrade → 403', async () => {
    const url = `ws://${own}/ws`;
    expect(await tryWs(url, { origin: 'http://evil.example' })).toBe(403);
    expect(await tryWs(url, { origin: `http://127.0.0.1:${port + 1}` })).toBe(403);
  });

  test('WS upgrade with a foreign Host → 403', async () => {
    expect(await tryWs(`ws://${own}/ws`, { headers: { host: `evil.example:${port}` } })).toBe(403);
  });

  test('WS upgrade from our own origin opens', async () => {
    expect(await tryWs(`ws://${own}/ws`, { origin: `http://${own}` })).toBe('open');
  });
});

describe('makeRequestGuard', () => {
  test('an explicit bind host is allowed alongside the loopback names', () => {
    const g = makeRequestGuard('192.168.1.20', () => 7474);
    expect(g.hostAllowed('192.168.1.20:7474')).toBe(true);
    expect(g.hostAllowed('localhost:7474')).toBe(true);
    expect(g.hostAllowed('192.168.1.21:7474')).toBe(false);
    expect(g.originAllowed('http://192.168.1.20:7474')).toBe(true);
    expect(g.originAllowed('https://192.168.1.20:7474')).toBe(false);
  });

  test("a wildcard bind also allows this machine's own names", () => {
    const g = makeRequestGuard('0.0.0.0', () => 7474);
    expect(g.hostAllowed(`${hostname()}:7474`)).toBe(true);
    expect(g.hostAllowed('0.0.0.0:7474')).toBe(true);
    expect(g.hostAllowed('evil.example:7474')).toBe(false);
  });

  test('IPv6 bind hosts match in bracket form', () => {
    const g = makeRequestGuard('fd00::1', () => 7474);
    expect(g.hostAllowed('[fd00::1]:7474')).toBe(true);
    expect(g.originAllowed('http://[fd00::1]:7474')).toBe(true);
  });

  test('port 80 may be left off, as browsers do', () => {
    const g = makeRequestGuard('127.0.0.1', () => 80);
    expect(g.hostAllowed('localhost')).toBe(true);
    expect(g.originAllowed('http://localhost')).toBe(true);
  });

  test('nothing passes before the server is listening', () => {
    const g = makeRequestGuard('127.0.0.1', () => undefined);
    expect(g.hostAllowed('127.0.0.1:7474')).toBe(false);
  });
});
