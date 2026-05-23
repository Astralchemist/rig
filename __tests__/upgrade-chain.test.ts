import { describe, expect, test } from 'bun:test';
import { Database as BunSqlite } from 'bun:sqlite';
import { MIGRATIONS } from '../generated/core/migrations.ts';

// Migrations should be (1) contiguous from 1, (2) idempotent on a fresh run,
// (3) produce the same final schema whether applied in one shot or as an
// upgrade chain from any intermediate version.
//
// The "from v1" path simulates a user who indexed before v2 shipped and then
// upgrades — we should arrive at the same end state as `Database.open(path)`
// on a brand-new file.

const versions = MIGRATIONS.map((m) => m.version);

const objectShape = (db: BunSqlite): string => {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string | null }[];
  // Normalize whitespace; SQLite re-emits SQL in canonical form so this is mostly
  // for indentation that differs between fresh and upgrade-chain runs.
  return rows
    .map((r) => `${r.type} ${r.name}\n${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n---\n');
};

const applyMigration = (db: BunSqlite, version: number): void => {
  const m = MIGRATIONS.find((x) => x.version === version);
  if (!m) throw new Error(`migration v${version} missing`);
  db.transaction(() => {
    db.exec(m.forward);
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
      m.version,
      Date.now(),
    );
  })();
};

const seedSchemaVersions = (db: BunSqlite): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_versions (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
};

describe('migration upgrade chain', () => {
  test('contiguous from 1', () => {
    for (let i = 0; i < versions.length; i++) {
      expect(versions[i]).toBe(i + 1);
    }
  });

  test('fresh apply produces a known schema', () => {
    const fresh = new BunSqlite(':memory:');
    seedSchemaVersions(fresh);
    for (const v of versions) applyMigration(fresh, v);
    const shape = objectShape(fresh);
    expect(shape).toContain('table nodes');
    expect(shape).toContain('table edges_semantic');
    expect(shape).toContain('table pending_edges');
    expect(shape).toContain('table mutation_log');
    expect(shape).toContain('table aliases');
    expect(shape).toContain('CREATE VIRTUAL TABLE aliases_fts');
    fresh.close();
  });

  test('upgrading from v1 to latest matches a fresh latest', () => {
    const fresh = new BunSqlite(':memory:');
    const upgraded = new BunSqlite(':memory:');

    seedSchemaVersions(fresh);
    seedSchemaVersions(upgraded);

    for (const v of versions) applyMigration(fresh, v);
    // Simulate "old user on v1": apply v1 only, then apply the rest as upgrades.
    applyMigration(upgraded, 1);
    for (const v of versions.slice(1)) applyMigration(upgraded, v);

    expect(objectShape(upgraded)).toBe(objectShape(fresh));
    fresh.close();
    upgraded.close();
  });

  test('opening an already-migrated DB is a no-op (Database.runMigrations skips applied)', async () => {
    // The production guard is schema_versions: each migration's forward SQL is only
    // executed when its version isn't already in the table. We don't claim the raw
    // forward SQL is idempotent (ALTER TABLE ADD COLUMN isn't) — we claim
    // Database.open is.
    const tmp = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = tmp.mkdtempSync(path.join(os.tmpdir(), 'rig-upgrade-'));
    const dbPath = path.join(dir, 'rig.db');
    const { Database } = await import('../packages/core/src/db/database.ts');
    const a = Database.open(dbPath);
    const versionsA = a.appliedVersions();
    a.close();
    // Re-open the SAME file. runMigrations should see all versions applied and skip.
    const b = Database.open(dbPath);
    const versionsB = b.appliedVersions();
    expect(versionsB).toEqual(versionsA);
    b.close();
    tmp.rmSync(dir, { recursive: true, force: true });
  });
});
