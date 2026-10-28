// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, type SqliteAdapter } from '@rig/core';
import { addAlias } from '@rig/core/db/alias-queries.ts';
import { upsertEmbedding } from '@rig/core/db/embed-queries.ts';
import { searchNodes, searchScored } from '@rig/core/db/search-queries.ts';
import { MIGRATIONS } from '../generated/core/migrations.ts';

const ftsIds = (db: SqliteAdapter, match: string): string[] =>
  (
    db
      .prepare(`SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY node_id`)
      .all(match) as { node_id: string }[]
  ).map((r) => r.node_id);

const insertNode = (
  db: SqliteAdapter,
  id: string,
  type: string,
  name: string,
  data: object,
): void => {
  db.prepare(
    `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`,
  ).run(id, type, name, JSON.stringify(data));
};

describe('v14 keyword index', () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-fts-'));
    db = Database.open(join(dir, 'rig.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('camelCase, snake_case and kebab-case names all hold "handle login"', () => {
    const a = db.adapter;
    insertNode(a, 'camel', 'function', 'handleLogin', { qualifiedName: 'auth.handleLogin' });
    insertNode(a, 'snake', 'function', 'handle_login', {});
    insertNode(a, 'kebab', 'function', 'handle-login', {});
    insertNode(a, 'other', 'function', 'handler', {});
    expect(ftsIds(a, 'tokens : "handle login"')).toEqual(['camel', 'kebab', 'snake']);
  });

  test('signature, docstring/description and free text are indexed', () => {
    const a = db.adapter;
    insertNode(a, 'fn', 'function', 'f', {
      signature: '(token: JwtToken)',
      docstring: 'Renews the lease',
    });
    insertNode(a, 'sk', 'skill', 'rig_x', { description: 'Rank anchors by gravity' });
    insertNode(a, 'wp', 'conversation-waypoint', 'Chose sqlite', {
      summary: 'single file store',
      rationale: 'zero ops',
      key_terms: ['durability', 'wal'],
    });
    insertNode(a, 'md', 'markdown-section', 'Install', { excerpt: 'Run the bootstrap script' });
    expect(ftsIds(a, 'signature : jwttoken')).toEqual(['fn']);
    expect(ftsIds(a, 'docstring : lease')).toEqual(['fn']);
    expect(ftsIds(a, 'docstring : gravity')).toEqual(['sk']);
    for (const w of ['single', 'zero', 'durability', 'wal']) {
      expect(ftsIds(a, `text : ${w}`)).toEqual(['wp']);
    }
    expect(ftsIds(a, 'text : bootstrap')).toEqual(['md']);
  });

  test('triggers keep the index in step with updates and deletes', () => {
    const a = db.adapter;
    insertNode(a, 'wp', 'conversation-waypoint', 'T', { summary: 'alpha' });
    a.prepare(`UPDATE nodes SET data = ? WHERE id = 'wp'`).run(JSON.stringify({ summary: 'beta' }));
    expect(ftsIds(a, 'alpha')).toEqual([]);
    expect(ftsIds(a, 'beta')).toEqual(['wp']);
    // Hubness-only writes don't touch the index (v7 scoping kept).
    a.prepare(`UPDATE nodes SET hubness = 0.5 WHERE id = 'wp'`).run();
    expect(ftsIds(a, 'beta')).toEqual(['wp']);
    a.prepare(`DELETE FROM nodes WHERE id = 'wp'`).run();
    expect(a.prepare(`SELECT COUNT(*) AS n FROM nodes_fts`).get()).toEqual({ n: 0 });
  });

  test('upgrading a v13 database backfills existing nodes into the new columns', () => {
    const raw = new BunSqlite(join(dir, 'old.db'));
    raw.exec(
      `CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    for (const m of MIGRATIONS.filter((m) => m.version <= 13)) {
      raw.exec(m.forward);
      raw.prepare(`INSERT INTO schema_versions VALUES (?, 0)`).run(m.version);
    }
    raw
      .prepare(
        `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`,
      )
      .run(
        'n1',
        'function',
        'refreshSession',
        JSON.stringify({ docstring: 'Renew an expired lease' }),
      );
    raw
      .prepare(
        `INSERT INTO embeddings (node_id, model, dim, vector) VALUES ('n1', 'm', 1, x'00000000')`,
      )
      .run();
    raw.close();

    const up = Database.open(join(dir, 'old.db'));
    expect(up.appliedVersions().at(-1)).toBe(14);
    expect(ftsIds(up.adapter, 'tokens : "refresh session"')).toEqual(['n1']);
    expect(ftsIds(up.adapter, 'docstring : expired')).toEqual(['n1']);
    expect(up.adapter.prepare(`SELECT seq FROM embeddings`).get()).toEqual({ seq: 0 });
    up.close();
  });

  test('embedding upserts stamp an increasing per-model seq', () => {
    const a = db.adapter;
    insertNode(a, 'x', 'function', 'x', {});
    insertNode(a, 'y', 'function', 'y', {});
    const v = new Float32Array([1, 0]);
    upsertEmbedding(a, 'x', 'm', v);
    upsertEmbedding(a, 'y', 'm', v);
    upsertEmbedding(a, 'x', 'm', v);
    const seqs = a.prepare(`SELECT node_id, seq FROM embeddings ORDER BY node_id`).all();
    expect(seqs).toEqual([
      { node_id: 'x', seq: 3 },
      { node_id: 'y', seq: 2 },
    ]);
  });
});

describe('keyword search', () => {
  let dir: string;
  let db: Database;
  const names = (q: string, opts = {}): string[] =>
    searchNodes(db.adapter, q, opts).map((n) => n.name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-kw-'));
    db = Database.open(join(dir, 'rig.db'));
    const a = db.adapter;
    insertNode(a, 'imp', 'import', 'AuthStore', {
      qualifiedName: 'app.AuthStore',
      filePath: 'app.ts',
    });
    insertNode(a, 'cls', 'class', 'AuthStore', { qualifiedName: 'AuthStore', filePath: 'auth.ts' });
    insertNode(a, 'login', 'method', 'login', {
      qualifiedName: 'AuthStore.login',
      filePath: 'auth.ts',
    });
    insertNode(a, 'renew', 'function', 'renewSession', {
      qualifiedName: 'renewSession',
      filePath: 'session.ts',
      docstring: 'Refresh an expired session token',
    });
    insertNode(a, 'evict', 'function', 'evictIdle', {
      qualifiedName: 'evictIdle',
      filePath: 'session.ts',
      docstring: 'Drop sessions idle too long',
    });
    insertNode(a, 'hl', 'function', 'handleLogin', {
      qualifiedName: 'handleLogin',
      filePath: 'h.ts',
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('identifier queries: exact name first, definitions before mentions', () => {
    expect(names('AuthStore')).toEqual(['AuthStore', 'AuthStore', 'login']);
    expect(searchNodes(db.adapter, 'AuthStore')[0]!.id).toBe('cls');
    expect(names('authStor')[0]).toBe('AuthStore');
    expect(names('AuthStore.login')[0]).toBe('login');
  });

  test('natural-language queries match any word, best overlap first', () => {
    // Every word had to match before: this found nothing.
    expect(names('where do we refresh expired sessions?')).toEqual(['renewSession', 'evictIdle']);
  });

  test('a phrase finds the identifier spelled out', () => {
    const [top] = searchScored(db.adapter, 'handle login');
    expect(top!.node.name).toBe('handleLogin');
    expect(top!.matchedBy).toEqual(['name', 'keyword']);
  });

  test('exact aliases come first and are marked', () => {
    addAlias(db.adapter, { nodeId: 'evict', alias: 'reaper', provenance: 'ai:test' });
    const [top] = searchScored(db.adapter, 'reaper');
    expect(top!.node.id).toBe('evict');
    expect(top!.matchedBy).toEqual(['alias', 'keyword']);
  });

  test('the kind filter and limit hold', () => {
    expect(names('AuthStore', { kind: 'import' })).toEqual(['AuthStore']);
    expect(names('sessions expired', { limit: 1 })).toHaveLength(1);
  });

  test('queries FTS5 cannot parse match nothing instead of throwing', () => {
    expect(names('"')).toEqual([]);
    expect(names('***')).toEqual([]);
  });
});
