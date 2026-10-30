// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import {
  activationAgentsSince,
  recordActivation,
  recordSessionClient,
} from '../packages/core/src/db/activation-queries.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { makeActivationRecorder, type ToolContext } from '../packages/mcp/src/dispatch.ts';
import { makeMessageHandler } from '../packages/mcp/src/server-handlers.ts';
import type { StdioTransport } from '../packages/mcp/src/transport.ts';

// C5: every MCP session knows its agent, so the map can colour activations.
describe('agent identity', () => {
  let dir: string;
  let rig: Rig;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-agent-'));
    writeFileSync(join(dir, 'a.ts'), 'export function login() {}\nexport function logout() {}\n');
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const handshake = async (sessionId: string, clientName: string, clientLabel: string | null) => {
    const ctx: ToolContext = {
      rig,
      sessionId,
      provenance: null,
      clientLabel,
      recordActivation: makeActivationRecorder(rig, sessionId),
    };
    const sent: unknown[] = [];
    const transport = {
      sendResult: (_id: unknown, r: unknown) => sent.push(r),
      sendError: (_id: unknown, _c: unknown, m: unknown) => sent.push(m),
    } as unknown as StdioTransport;
    const handle = makeMessageHandler(transport, { tools: [] } as never, new Map(), ctx);
    await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: clientName, version: '1' } },
    } as never);
    return { ctx, sent };
  };

  test('the handshake records the client; the install label wins when present', async () => {
    await handshake('s-cursor', 'cursor-vscode', 'cursor');
    await handshake('s-claude', 'claude-code', null);
    const rows = rig.database.adapter
      .prepare('SELECT session_id, client, client_label FROM session_clients ORDER BY session_id')
      .all();
    expect(rows).toEqual([
      { session_id: 's-claude', client: 'claude-code', client_label: null },
      { session_id: 's-cursor', client: 'cursor-vscode', client_label: 'cursor' },
    ]);
  });

  test('activations map to their agent; sessions with no known agent are left out', () => {
    const db = rig.database.adapter;
    const [a, b] = rig.searchNodes('login').concat(rig.searchNodes('logout'));
    recordSessionClient(db, 's1', 'same-name', 'codex');
    recordSessionClient(db, 's2', 'same-name', 'claude');
    const before = Date.now() - 1;
    recordActivation(db, a!.id, 'mcp', { sessionId: 's1' });
    recordActivation(db, b!.id, 'mcp', { sessionId: 's2' });
    recordActivation(db, b!.id, 'mcp', { sessionId: 'unknown-session' });
    const agents = activationAgentsSince(db, before);
    expect(agents[a!.id]).toBe('codex');
    expect(agents[b!.id]).toBe('claude');
  });
});
