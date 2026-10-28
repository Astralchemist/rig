// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../generated/core/migrations.ts';
import { rigNeighborsHandler } from '../generated/mcp/handlers/rig_neighbors.handler.ts';
import { Rig } from '../packages/core/src/index.ts';
import { Database } from '../packages/core/src/db/database.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import type { ToolContext } from '../packages/mcp/src/dispatch.ts';

// Accepting a proposal copied it into edges_semantic without its kind and
// evidence URLs. v13 adds both columns and backfills rows accepted earlier.
describe('migration v13: kind + source_urls on edges_semantic', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-v13-'));
    dbPath = join(dir, 'rig.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A v12 database with two accepted proposals and one semantic edge that no
  // proposal backs, the way an older rig left it.
  const seedV12 = (): void => {
    const raw = new BunSqlite(dbPath);
    raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 12)) {
      raw.exec(m.forward);
      raw
        .prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(m.version, 1);
    }
    const node = raw.prepare(
      `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, 'function', ?, '{}', 1, 1)`,
    );
    for (const id of ['function:a', 'function:b', 'function:c']) node.run(id, id);
    const pending = raw.prepare(
      `INSERT INTO pending_edges (src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status, source_urls)
       VALUES (?, ?, ?, 0.5, 'ai:test', 'test rationale', 1, 's1', ?, ?)`,
    );
    pending.run('function:a', 'function:b', 'calls', 'accepted', '["https://example.com/a"]');
    // A later rejected proposal of another kind for the same pair is ignored.
    pending.run('function:a', 'function:b', 'documents', 'rejected', null);
    pending.run('function:b', 'function:c', 'depends_on', 'accepted', null);
    const semantic = raw.prepare(
      `INSERT INTO edges_semantic (src, dst, weight, provenance, rationale, created_at)
       VALUES (?, ?, 0.5, ?, 'test rationale', 2)`,
    );
    semantic.run('function:a', 'function:b', 'ai:test');
    semantic.run('function:b', 'function:c', 'ai:test');
    semantic.run('function:a', 'function:c', 'user:web');
    raw.close();
  };

  test('backfills kind and source_urls from the accepted proposal', () => {
    seedV12();
    const db = Database.open(dbPath);
    try {
      expect(
        db.adapter
          .prepare(`SELECT src, dst, kind, source_urls FROM edges_semantic ORDER BY src, dst`)
          .all(),
      ).toEqual([
        {
          src: 'function:a',
          dst: 'function:b',
          kind: 'calls',
          source_urls: '["https://example.com/a"]',
        },
        { src: 'function:a', dst: 'function:c', kind: 'related', source_urls: null },
        { src: 'function:b', dst: 'function:c', kind: 'depends_on', source_urls: null },
      ]);
    } finally {
      db.close();
    }
  });

  test('adds the meta key/value table', () => {
    const db = Database.open(dbPath);
    try {
      db.adapter.prepare(`INSERT INTO meta (key, value) VALUES ('k', 'v')`).run();
      expect(db.adapter.prepare(`SELECT key, value FROM meta`).all()).toEqual([
        { key: 'k', value: 'v' },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('accepted edges keep their kind and evidence', () => {
  let project: string;
  let rig: Rig;
  let alpha: string;
  let beta: string;
  const ctx = { sessionId: 'agent-1', actor: 'ai:test' };
  const web = { sessionId: 'web', actor: 'user:web' };
  const URLS = ['https://example.com/spec', 'https://example.com/issue/7'];
  const BETA_TS = 'export function beta(): void {}\n';

  const one = <T>(sql: string, ...params: unknown[]): T =>
    rig.database.adapter.prepare(sql).get(...params) as T;
  const idOf = (name: string): string =>
    one<{ id: string }>(`SELECT id FROM nodes WHERE name = ? AND type = 'function'`, name).id;
  const toolCtx = (): ToolContext => ({
    rig,
    sessionId: 'agent-1',
    provenance: 'ai:test',
    recordActivation: () => {},
  });
  const acceptCalls = (): void => {
    const pid = rig.writes.proposeEdge(
      {
        src: alpha,
        dst: beta,
        kind: 'calls',
        rationale: 'alpha calls beta at runtime',
        sourceUrls: URLS,
      },
      ctx,
    );
    expect(rig.writes.acceptPending(pid, web)).not.toBeNull();
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'rig-accepted-'));
    writeFileSync(join(project, 'a.ts'), 'export function alpha(): void {}\n');
    writeFileSync(join(project, 'b.ts'), BETA_TS);
    rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await rig.indexAll();
    alpha = idOf('alpha');
    beta = idOf('beta');
  });

  afterEach(() => {
    rig.close();
    rmSync(project, { recursive: true, force: true });
  });

  test('accepting copies the kind and source_urls into edges_semantic', () => {
    acceptCalls();
    expect(
      one(`SELECT kind, source_urls FROM edges_semantic WHERE src = ? AND dst = ?`, alpha, beta),
    ).toEqual({ kind: 'calls', source_urls: JSON.stringify(URLS) });
  });

  test('rig_neighbors, /api/node/:id/neighbors and /api/graph report them', async () => {
    acceptCalls();
    const semantic = {
      src: alpha,
      dst: beta,
      kind: 'calls',
      weight: 0.5,
      table: 'semantic',
      source_urls: URLS,
    };
    const all = (await rigNeighborsHandler.run({ id: alpha }, toolCtx())) as { edges: unknown[] };
    expect(all.edges).toContainEqual(semantic);
    // The kind filter matches the semantic edge by its own kind.
    const calls = (await rigNeighborsHandler.run({ id: alpha, kind: 'calls' }, toolCtx())) as {
      edges: unknown[];
    };
    expect(calls.edges).toContainEqual(semantic);
    const related = (await rigNeighborsHandler.run({ id: alpha, kind: 'related' }, toolCtx())) as {
      edges: unknown[];
    };
    expect(related.edges).toEqual([]);

    // The REST routes serve these core reads as-is.
    expect(rig.getNeighbors(alpha)).toContainEqual(semantic);
    expect(rig.snapshot().edges_semantic).toEqual([
      { src: alpha, dst: beta, weight: 0.5, kind: 'calls', source_urls: URLS },
    ]);
  });

  test('kind and source_urls survive the orphan snapshot and re-attach', async () => {
    acceptCalls();
    writeFileSync(join(project, 'b.ts'), 'export const keep = 1;\n');
    await rig.sync();
    const payload = JSON.parse(
      one<{ payload: string }>(`SELECT payload FROM orphaned_memory WHERE node_id = ?`, beta)
        .payload,
    ) as { semantic_edges: unknown[] };
    expect(payload.semantic_edges).toEqual([
      expect.objectContaining({ kind: 'calls', source_urls: JSON.stringify(URLS) }),
    ]);

    writeFileSync(join(project, 'b.ts'), BETA_TS);
    await rig.sync();
    expect(one(`SELECT src, dst, kind, source_urls FROM edges_semantic`)).toEqual({
      src: alpha,
      dst: idOf('beta'),
      kind: 'calls',
      source_urls: JSON.stringify(URLS),
    });
  });
});
