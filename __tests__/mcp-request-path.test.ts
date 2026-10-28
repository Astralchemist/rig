// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '@rig/core';
import { DeterministicEmbedder } from '@rig/core/embed/deterministic-embedder.ts';

const ROOT = resolve(__dirname, '..');
// Runs serveMcp() — the server behind `rig serve --mcp` — so requests take the
// real path: stdio transport → message handler → session context → handler.
const MCP_ENTRY = join(ROOT, 'scripts/smoke-mcp-entry.ts');

interface RpcResponse {
  id?: number;
  result?: { content: { type: string; text: string }[] } & Record<string, unknown>;
  error?: { code: number; message: string; data?: { rigError?: string; uri?: string } };
}

// Start a server, send the frames, and resolve once every request has an
// answer and the server has exited (it stops when stdin closes).
const rpc = (project: string, frames: Record<string, unknown>[]): Promise<Map<number, RpcResponse>> =>
  new Promise((resolveRpc, reject) => {
    const want = frames.filter((f) => typeof f.id === 'number').length;
    const got = new Map<number, RpcResponse>();
    const child = spawn(process.execPath, [MCP_ENTRY, project], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.stdout.on('data', (b: Buffer) => {
      buf += b.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        const msg = JSON.parse(line) as RpcResponse;
        if (typeof msg.id === 'number') got.set(msg.id, msg);
      }
      if (got.size >= want) child.stdin.end();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (got.size >= want) resolveRpc(got);
      else reject(new Error(`MCP server exited (${code}) after ${got.size}/${want} responses: ${stderr}`));
    });
    child.stdin.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  });

const textOf = (r: RpcResponse | undefined): string => {
  expect(r?.error).toBeUndefined();
  return r!.result!.content[0]!.text;
};

describe('heavy tools over the MCP request path', () => {
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-mcp-path-'));
    writeFileSync(
      join(project, 'auth.ts'),
      `export class AuthStore {\n  login(user: string): void {\n    console.log(user);\n  }\n}\n`,
    );
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
    // The spawned server picks its embedder from config; keep it offline.
    writeFileSync(join(project, '.rig', 'config.json'), JSON.stringify({ embedder: { kind: 'deterministic' } }));
  });

  afterAll(() => rmSync(project, { recursive: true, force: true }));

  test('rig_context and rig_explore return results, not MAIN_SESSION_FORBIDDEN', async () => {
    const res = await rpc(project, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'rig_context', arguments: { task: 'AuthStore' } },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'rig_explore', arguments: { question: 'AuthStore' } },
      },
    ]);

    const bundle = JSON.parse(textOf(res.get(2))) as { context: string; anchor_count: number };
    expect(bundle.anchor_count).toBeGreaterThan(0);
    expect(bundle.context).toContain('class AuthStore');

    const explored = JSON.parse(textOf(res.get(3))) as { anchors: { name: string; source: string }[] };
    const store = explored.anchors.find((a) => a.name === 'AuthStore');
    expect(store?.source).toContain('class AuthStore');
  });
});

describe('the orientation map over the MCP request path', () => {
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-mcp-overview-'));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'mapped', description: 'A mapped project.' }),
    );
    writeFileSync(join(project, 'auth.ts'), `export class AuthStore {}\n`);
    for (const f of ['login.ts', 'use.ts']) {
      writeFileSync(join(project, f), `import { AuthStore } from './auth';\nnew AuthStore();\n`);
    }
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    rig.close();
    writeFileSync(
      join(project, '.rig', 'config.json'),
      JSON.stringify({ embedder: { kind: 'deterministic' } }),
    );
  });

  afterAll(() => rmSync(project, { recursive: true, force: true }));

  test('initialize advertises resources; list, read, unknown URI; rig_overview returns the same map', async () => {
    const res = await rpc(project, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'rig://overview' } },
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'rig://nope' } },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'rig_overview', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'rig_overview', arguments: { budget: 300 } },
      },
      { jsonrpc: '2.0', id: 7, method: 'resources/templates/list', params: {} },
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
    ]);

    const init = res.get(1)?.result as { capabilities: Record<string, unknown> };
    expect(init.capabilities).toEqual({ tools: {}, resources: {} });

    const list = res.get(2)?.result as { resources: Record<string, string>[] };
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]).toMatchObject({
      uri: 'rig://overview',
      name: 'overview',
      title: 'Repository overview',
      mimeType: 'text/markdown',
    });

    const read = res.get(3)?.result as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]!.uri).toBe('rig://overview');
    expect(read.contents[0]!.mimeType).toBe('text/markdown');
    expect(read.contents[0]!.text).toStartWith('# Repository overview: mapped\n');
    expect(read.contents[0]!.text).toContain('- Hub files (used by N files): auth.ts (2)');

    expect(res.get(4)?.error?.code).toBe(-32002);
    expect(res.get(4)?.error?.data?.uri).toBe('rig://nope');

    const tool = JSON.parse(textOf(res.get(5))) as {
      map: string;
      generated_at: number;
      nodes: number;
    };
    expect(tool.map).toBe(read.contents[0]!.text);
    expect(tool.generated_at).toBeGreaterThan(0);
    expect(tool.nodes).toBeGreaterThan(0);
    const small = JSON.parse(textOf(res.get(6))) as { map: string };
    expect(small.map.length).toBeLessThanOrEqual(1200);

    expect(res.get(7)?.result).toEqual({ resourceTemplates: [] });
    const tools = res.get(8)?.result as { tools: { name: string }[] };
    expect(tools.tools.some((t) => t.name === 'rig_overview')).toBe(true);
  });
});
