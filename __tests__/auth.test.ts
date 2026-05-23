import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';

describe('auth — bearer-token gate (Flavor A)', () => {
  let project: string;
  let handle: WebHandle | null = null;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-auth-'));
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(project, { recursive: true, force: true });
  });

  test('default (loopback) leaves auth off — /api/status is open', async () => {
    handle = await serveWeb({ projectRoot: project, port: 0 });
    expect(handle.token).toBeNull();
    const res = await fetch(`${handle.url}/api/status`);
    expect(res.ok).toBe(true);
  });

  test('--auth=true generates .runtime mode 0600 + gates /api/*', async () => {
    handle = await serveWeb({ projectRoot: project, port: 0, auth: true });
    expect(handle.token).not.toBeNull();
    expect(handle.token!.length).toBeGreaterThanOrEqual(64);

    const runtimePath = join(project, '.rig', '.runtime');
    expect(existsSync(runtimePath)).toBe(true);
    const mode = statSync(runtimePath).mode & 0o777;
    expect(mode).toBe(0o600);

    const unauth = await fetch(`${handle.url}/api/status`);
    expect(unauth.status).toBe(401);

    const authed = await fetch(`${handle.url}/api/status`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(authed.status).toBe(200);
  });

  test('refuses to bind non-loopback without --auth', async () => {
    await expect(
      serveWeb({ projectRoot: project, port: 0, host: '0.0.0.0', auth: false }),
    ).rejects.toThrow(/refusing to bind/i);
  });

  test('/auth?t=token sets cookie + redirects', async () => {
    handle = await serveWeb({ projectRoot: project, port: 0, auth: true });
    const res = await fetch(`${handle.url}/auth?t=${handle.token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/rig_token=/);
    expect(setCookie).toMatch(/HttpOnly/);
  });

  test('/auth with wrong token returns 401', async () => {
    handle = await serveWeb({ projectRoot: project, port: 0, auth: true });
    const res = await fetch(`${handle.url}/auth?t=wrong`);
    expect(res.status).toBe(401);
  });

  test('/api/session/me works as a status probe', async () => {
    handle = await serveWeb({ projectRoot: project, port: 0, auth: true });
    const no = await fetch(`${handle.url}/api/session/me`);
    expect(no.status).toBe(401);
    const yes = await fetch(`${handle.url}/api/session/me`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    const body = (await yes.json()) as { authed: boolean };
    expect(yes.status).toBe(200);
    expect(body.authed).toBe(true);
  });
});
