import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@rig/core/db/database.ts';

const EXPECTED_TABLES = [
  'activations',
  'edges',
  'edges_semantic',
  'embeddings',
  'files',
  'nodes',
  'nodes_fts',
  'schema_versions',
  'unresolved_refs',
];

describe('Database — schema v1', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migration v1 on a fresh DB', () => {
    const db = Database.open(join(dir, 'rig.db'));
    expect(db.appliedVersions()).toEqual([1]);
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
    expect(count.n).toBe(1);
    expect(db.appliedVersions()).toEqual([1]);
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
