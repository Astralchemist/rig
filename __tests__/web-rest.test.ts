// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { serveWeb, type WebHandle } from '../packages/web/src/index.ts';

const PORT = 7489;

describe('web REST endpoints', () => {
  let project: string;
  let handle: WebHandle;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-web-rest-'));
    writeFileSync(
      join(project, 'app.ts'),
      `export class Widget {
  build(): void { console.log('built'); }
  destroy(): void { console.log('destroyed'); }
}`,
    );
    const rig = await Rig.init(project);
    await rig.indexAll();
    rig.close();
    handle = await serveWeb({ projectRoot: project, port: PORT });
  });

  afterAll(async () => {
    await handle.close();
    rmSync(project, { recursive: true, force: true });
  });

  const base = (): string => `http://127.0.0.1:${PORT}`;
  const fetchJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(base() + path);
    return { status: res.status, body: (await res.json()) as T };
  };

  test('GET /health', async () => {
    const { status, body } = await fetchJson<{ ok: boolean; name: string }>('/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe('rig-web');
  });

  test('GET /api/status', async () => {
    const { status, body } = await fetchJson<{ initialized: boolean; nodes: number }>(
      '/api/status',
    );
    expect(status).toBe(200);
    expect(body.initialized).toBe(true);
    expect(body.nodes).toBeGreaterThan(0);
  });

  test('GET /api/graph returns nodes + edge arrays', async () => {
    const { body } = await fetchJson<{
      nodes: unknown[];
      edges_structural: unknown[];
      edges_semantic: unknown[];
    }>('/api/graph?limit=100');
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(body.edges_structural)).toBe(true);
    expect(Array.isArray(body.edges_semantic)).toBe(true);
  });

  test('GET /api/search returns FTS hits', async () => {
    const { body } = await fetchJson<Array<{ name: string }>>('/api/search?q=Widget');
    expect(body.some((n) => n.name === 'Widget')).toBe(true);
  });

  test('GET /api/search without q returns 400', async () => {
    const res = await fetch(base() + '/api/search');
    expect(res.status).toBe(400);
  });

  test('GET /api/node/:id and /pull and /neighbors', async () => {
    const hits = await fetchJson<Array<{ id: string }>>('/api/search?q=Widget');
    const id = hits.body[0]!.id;
    const node = await fetchJson<{ id: string; neighbor_counts: Record<string, number> }>(
      `/api/node/${encodeURIComponent(id)}`,
    );
    expect(node.body.id).toBe(id);
    expect(typeof node.body.neighbor_counts).toBe('object');

    const pull = await fetchJson<unknown[]>(`/api/node/${encodeURIComponent(id)}/pull?k=5`);
    expect(Array.isArray(pull.body)).toBe(true);

    const neighbors = await fetchJson<unknown[]>(`/api/node/${encodeURIComponent(id)}/neighbors`);
    expect(Array.isArray(neighbors.body)).toBe(true);
  });

  test('GET /api/node/:id returns 404 for unknown id', async () => {
    const res = await fetch(base() + '/api/node/nope');
    expect(res.status).toBe(404);
  });

  test('GET /api/files', async () => {
    const { body } = await fetchJson<Array<{ path: string }>>('/api/files');
    expect(body.some((f) => f.path === 'app.ts')).toBe(true);
  });
});
