// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@rig/core/db/database.ts';

const EXPECTED_TABLES = [
  'activations',
  'annotations',
  'edges',
  'edges_semantic',
  'embeddings',
  'file_edges',
  'file_refs',
  'files',
  'meta',
  'mutation_log',
  'nodes',
  'nodes_fts',
  'orphaned_memory',
  'pending_edges',
  'schema_versions',
  'sessions',
  'unresolved_refs',
];

describe('Database — schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies all migrations on a fresh DB', () => {
    const db = Database.open(join(dir, 'rig.db'));
    expect(db.appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    db.close();
  });

  it('creates every expected user table', () => {
    const db = Database.open(join(dir, 'rig.db'));
    const tables = (
      db.adapter
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('reopening the same DB is a no-op (idempotent migrations)', () => {
    const dbPath = join(dir, 'rig.db');
    Database.open(dbPath).close();
    const db = Database.open(dbPath);
    const count = db.adapter
      .prepare('SELECT COUNT(*) AS n FROM schema_versions')
      .get() as { n: number };
    expect(count.n).toBe(15);
    expect(db.appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    db.close();
  });

  it('enables WAL journaling', () => {
    const db = Database.open(join(dir, 'rig.db'));
    const mode = db.adapter.pragma('journal_mode') as { journal_mode: string } | string | undefined;
    const value = typeof mode === 'object' && mode ? mode.journal_mode : mode;
    expect(value).toBe('wal');
    db.close();
  });
});
