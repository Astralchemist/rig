import { MIGRATIONS } from '@rig/generated/core/migrations.ts';
import type { SqliteAdapter, SqliteAdapterFactory } from './adapter.ts';
import { selectSqliteFactorySync } from './factory.ts';

export class Database {
  static open(dbPath: string, factory?: SqliteAdapterFactory): Database {
    const f = factory ?? selectSqliteFactorySync();
    const adapter = f.open(dbPath);
    adapter.pragma('journal_mode = WAL');
    adapter.pragma('foreign_keys = ON');
    const db = new Database(adapter);
    db.runMigrations();
    return db;
  }

  private constructor(readonly adapter: SqliteAdapter) {}

  runMigrations(): void {
    this.adapter.exec(
      `CREATE TABLE IF NOT EXISTS schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    const rows = this.adapter
      .prepare('SELECT version FROM schema_versions')
      .all() as { version: number }[];
    const applied = new Set(rows.map((r) => r.version));

    const insert = this.adapter.prepare(
      'INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)',
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.adapter.transaction(() => {
        this.adapter.exec(m.forward);
        insert.run(m.version, Date.now());
      })();
    }
  }

  appliedVersions(): number[] {
    return (this.adapter.prepare('SELECT version FROM schema_versions ORDER BY version').all() as {
      version: number;
    }[]).map((r) => r.version);
  }

  close(): void {
    this.adapter.close();
  }
}
