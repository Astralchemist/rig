// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from '../generated/mcp/tools-manifest.json' with { type: 'json' };
import { mcpSession, type McpRun } from './support/mcp.ts';

// An MCP host that launches `rig serve --mcp` outside a rig project must see a
// healthy server: initialize and tools/list work, and every tool call answers
// with a structured NOT_INITIALIZED error that says how to fix it.
describe('rig serve --mcp in a directory without .rig/', () => {
  let base: string;
  let dir: string;
  let run: McpRun;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'rig-mcp-uninit-'));
    dir = join(base, 'not-a-rig-project');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(base, 'home'), { recursive: true });
    run = await mcpSession(['serve', '--mcp'], { cwd: dir, home: join(base, 'home') }, [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'test-host' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list', params: {} },
      { id: 3, method: 'tools/call', params: { name: 'rig_status', arguments: {} } },
      { id: 4, method: 'tools/call', params: { name: 'rig_search', arguments: { query: 'x' } } },
      { id: 5, method: 'tools/call', params: { name: 'rig_nope', arguments: {} } },
      { id: 6, method: 'resources/list', params: {} },
      { id: 7, method: 'resources/read', params: { uri: 'rig://overview' } },
    ]);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test('initialize answers normally', () => {
    const r = run.byId['1']?.result as { serverInfo?: { name?: string } } | undefined;
    expect(r?.serverInfo?.name).toBe('rig');
  });

  test('tools/list returns the full tool surface', () => {
    const r = run.byId['2']?.result as { tools?: Array<{ name: string }> } | undefined;
    expect(r?.tools?.map((t) => t.name)).toEqual(manifest.tools.map((t) => t.name));
  });

  test('every tool call returns NOT_INITIALIZED with the directory and the fix', () => {
    const root = realpathSync(dir);
    for (const id of ['3', '4']) {
      const err = run.byId[id]?.error;
      expect(err?.data?.rigError).toBe('NOT_INITIALIZED');
      expect(realpathSync(err?.data?.projectRoot as string)).toBe(root);
      expect(err?.data?.fix).toEqual(['rig init', 'rig start']);
      expect(err?.message).toContain('rig is not initialised in');
      expect(err?.message).toContain('`rig init`');
    }
  });

  test('resources/list works; reading the overview answers NOT_INITIALIZED', () => {
    const r = run.byId['6']?.result as { resources?: Array<{ uri: string }> } | undefined;
    expect(r?.resources?.map((x) => x.uri)).toEqual(['rig://overview']);
    expect(run.byId['7']?.error?.data?.rigError).toBe('NOT_INITIALIZED');
  });

  test('unknown tools still report TOOL_NOT_FOUND', () => {
    expect(run.byId['5']?.error?.data?.rigError).toBe('TOOL_NOT_FOUND');
  });

  test('logs why on stderr, exits cleanly on EOF, and creates nothing', () => {
    expect(run.stderr).toContain('no .rig/ in');
    expect(run.code).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});
