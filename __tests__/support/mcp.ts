// SPDX-License-Identifier: Apache-2.0
// Drive `rig serve --mcp` over stdio like an MCP host: spawn it, write JSON-RPC
// frames, collect responses by id, then close stdin (which ends the server).
import { spawn } from 'node:child_process';
import { CLI, cliEnv } from './cli.ts';

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

export interface McpRun {
  byId: Record<string, JsonRpcResponse>;
  stderr: string;
  code: number | null;
}

export const mcpSession = (
  args: string[],
  opts: { cwd: string; home: string },
  frames: Array<{ id?: number; method: string; params?: unknown }>,
  timeoutMs = 30_000,
): Promise<McpRun> =>
  new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: cliEnv(opts.home),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Set(frames.filter((f) => f.id !== undefined).map((f) => String(f.id)));
    const byId: Record<string, JsonRpcResponse> = {};
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id === null || msg.id === undefined) continue;
        byId[String(msg.id)] = msg;
        pending.delete(String(msg.id));
        if (!pending.size) child.stdin.end();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ byId, stderr, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(
      frames.map((f) => JSON.stringify({ jsonrpc: '2.0', ...f })).join('\n') + '\n',
    );
  });

// The JSON a tools/call returned (rig wraps results as one text content block).
export const toolResult = (r: JsonRpcResponse | undefined): Record<string, unknown> | null => {
  const text = (r?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
};
