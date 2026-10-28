// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '../generated/core/migrations.ts';
import { Database } from '../packages/core/src/db/database.ts';

// Annotations used to live in nodes.data.annotations, which every re-extract
// rewrites. v12 moves them into their own table; this locks in the data
// migration for databases written before it.
describe('annotations table (v12)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-annotations-'));
    dbPath = join(dir, 'rig.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Build a v11 database the way an older rig left it.
  const seedV11 = (rows: Array<{ id: string; data: Record<string, unknown> }>): void => {
    const raw = new BunSqlite(dbPath);
    raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 11)) {
      raw.exec(m.forward);
      raw
        .prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(m.version, 1);
    }
    const ins = raw.prepare(
      `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, 'function', ?, ?, 1, 1)`,
    );
    for (const r of rows) ins.run(r.id, r.id, JSON.stringify(r.data));
    raw.close();
  };

  test('migration copies legacy data.annotations into the table and strips them from data', () => {
    seedV11([
      {
        id: 'function:a',
        data: {
          qualifiedName: 'a',
          filePath: 'a.ts',
          annotations: [
            { note: 'auth boundary', ts: 10, actor: 'ai:test', rationale: 'first note' },
            { note: 'renamed from Foo', ts: 20, actor: 'ai:test', rationale: 'second note' },
          ],
        },
      },
      { id: 'function:b', data: { qualifiedName: 'b', filePath: 'b.ts' } },
    ]);

    const db = Database.open(dbPath);
    try {
      const rows = db.adapter
        .prepare(`SELECT node_id, note, ts, actor, rationale FROM annotations ORDER BY id`)
        .all();
      expect(rows).toEqual([
        {
          node_id: 'function:a',
          note: 'auth boundary',
          ts: 10,
          actor: 'ai:test',
          rationale: 'first note',
        },
        {
          node_id: 'function:a',
          note: 'renamed from Foo',
          ts: 20,
          actor: 'ai:test',
          rationale: 'second note',
        },
      ]);
      const data = (
        db.adapter.prepare(`SELECT data FROM nodes WHERE id = 'function:a'`).get() as {
          data: string;
        }
      ).data;
      expect(JSON.parse(data)).toEqual({ qualifiedName: 'a', filePath: 'a.ts' });
    } finally {
      db.close();
    }
  });

  test('annotations cascade with their node', () => {
    seedV11([
      { id: 'function:a', data: { annotations: [{ note: 'x', ts: 1, actor: 'ai:test' }] } },
    ]);
    const db = Database.open(dbPath);
    try {
      db.adapter.prepare(`DELETE FROM nodes WHERE id = 'function:a'`).run();
      const n = db.adapter.prepare(`SELECT COUNT(*) AS n FROM annotations`).get() as { n: number };
      expect(n.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
