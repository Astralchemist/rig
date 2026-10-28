// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../generated/core/migrations.ts';
import { Database } from '../packages/core/src/db/database.ts';

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
