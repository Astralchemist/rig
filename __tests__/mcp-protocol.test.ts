// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { makeActivationRecorder, type ToolContext } from '../packages/mcp/src/dispatch.ts';
import {
  buildHandlersMap,
  makeMessageHandler,
  negotiateProtocol,
} from '../packages/mcp/src/server-handlers.ts';
import * as handlersModule from '../generated/mcp/handlers-index.ts';
import manifest from '../generated/mcp/tools-manifest.json' with { type: 'json' };
import type { StdioTransport } from '../packages/mcp/src/transport.ts';

// Roadmap step 4: version negotiation, structured results, tool errors the
// model can see, and annotations, without breaking 2024-11-05 clients.
describe('MCP protocol', () => {
  let dir: string;
  let rig: Rig;
  let sent: Record<string, { result?: any; error?: any }>;
  let handle: (m: unknown) => Promise<void>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rig-protocol-'));
    writeFileSync(join(dir, 'a.ts'), 'export function login() {}\n');
    rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    sent = {};
    const transport = {
      sendResult: (id: unknown, result: unknown) => (sent[String(id)] = { result }),
      sendError: (id: unknown, code: number, message: string, data?: unknown) =>
        (sent[String(id)] = { error: { code, message, data } }),
    } as unknown as StdioTransport;
    const ctx: ToolContext = {
      rig,
      sessionId: 's',
      provenance: null,
      recordActivation: makeActivationRecorder(rig, 's'),
    };
    handle = makeMessageHandler(
      transport,
      manifest as never,
      buildHandlersMap(handlersModule),
      ctx,
    ) as never;
  });
  afterEach(() => {
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('negotiation: a supported version is echoed, anything else gets the newest', async () => {
    expect(negotiateProtocol('2024-11-05')).toBe('2024-11-05');
    expect(negotiateProtocol('2025-06-18')).toBe('2025-06-18');
    expect(negotiateProtocol('1999-01-01')).toBe('2025-06-18');
    await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(sent['1']!.result.protocolVersion).toBe('2025-03-26');
  });

  test('results carry structuredContent next to the text copy', async () => {
    await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'rig_status', arguments: {} },
    });
    const r = sent['2']!.result;
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    expect(r.isError).toBeUndefined();
  });

  test('a tool failure comes back as an isError result; an unknown tool stays a protocol error', async () => {
    await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'rig_node', arguments: { id: 'nope' } },
    });
    expect(sent['3']!.result.isError).toBe(true);
    expect(sent['3']!.result.content[0].text).toMatch(/^NODE_NOT_FOUND: /);
    await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'rig_nope', arguments: {} },
    });
    expect(sent['4']!.error.data.rigError).toBe('TOOL_NOT_FOUND');
  });

  test('tools/list carries annotations: reads are read-only, only rig_undo is destructive, nothing is open-world', async () => {
    await handle({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const tools = sent['5']!.result.tools as {
      name: string;
      tier: string;
      annotations: Record<string, boolean>;
    }[];
    for (const t of tools) {
      expect(t.annotations.openWorldHint).toBe(false);
      expect(t.annotations.readOnlyHint).toBe(t.tier !== 'write');
      expect(t.annotations.destructiveHint).toBe(t.name === 'rig_undo');
    }
  });
});
