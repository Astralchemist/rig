// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';
import { WEB_ADDRESS_FILE } from '@rig/core/web-address.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';
import { rigSessionTokenHandler } from '../generated/mcp/handlers/rig_session_token.handler.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';

const TOKEN = 'a'.repeat(64);

// Web ports are per project (and walk forward past a busy one), so the login
// URL has to come from where the server actually bound, not a fixed 7474.
describe('rig_session_token login URL', () => {
  let project: string;
  let rig: Rig;
  let web: WebHandle | null = null;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-session-token-'));
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
  });

  afterEach(async () => {
    if (web) {
      await web.close();
      web = null;
    }
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    rig,
    sessionId: 'test',
    isMainSession: false,
    provenance: null,
    recordActivation: () => {},
  });

  const call = async (args: Record<string, unknown> = {}): Promise<{ token: string; login_url: string }> =>
    (await rigSessionTokenHandler.run(args, ctx())) as { token: string; login_url: string };

  test('points at the port the running web server bound', async () => {
    // port 0 → the OS picks a free port, so nothing can guess it.
    web = await serveWeb({ projectRoot: project, port: 0, auth: true });
    const { token, login_url } = await call();
    expect(token).toBe(web.token!);
    expect(login_url).toBe(`${web.url}/auth?t=${web.token}`);
    const res = await fetch(login_url, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  test('reads host and port from the recorded address', async () => {
    writeFileSync(join(project, '.rig', '.runtime'), TOKEN);
    writeFileSync(join(project, '.rig', WEB_ADDRESS_FILE), JSON.stringify({ host: '::1', port: 7519 }));
    const { login_url } = await call();
    expect(login_url).toBe(`http://[::1]:7519/auth?t=${TOKEN}`);
  });

  test('falls back to 127.0.0.1:7474 when no address was recorded', async () => {
    writeFileSync(join(project, '.rig', '.runtime'), TOKEN);
    const { login_url } = await call();
    expect(login_url).toBe(`http://127.0.0.1:7474/auth?t=${TOKEN}`);
  });

  test('explicit host and port override the recorded address', async () => {
    writeFileSync(join(project, '.rig', '.runtime'), TOKEN);
    writeFileSync(join(project, '.rig', WEB_ADDRESS_FILE), JSON.stringify({ host: '127.0.0.1', port: 7519 }));
    const { login_url } = await call({ host: 'localhost', port: 7999 });
    expect(login_url).toBe(`http://localhost:7999/auth?t=${TOKEN}`);
  });
});
