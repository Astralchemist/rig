// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
// Original: src/db/sqlite-adapter.ts (node:sqlite backend).
// Re-shaped for bun:sqlite; pragma/transaction helpers preserved verbatim
// in shape.

import { createRequire } from 'node:module';
import type { Database } from 'bun:sqlite';
import type { SqliteAdapter, SqliteAdapterFactory, SqliteStatement } from './adapter.ts';

// Load `bun:sqlite` via a runtime-computed specifier so bundlers can't hoist a
// static `import … from "bun:sqlite"` into the Node entry — Node rejects the
// `bun:` URL scheme at load time. This module is only ever reached under Bun
// (factory.ts picks it by runtime detection), where the require resolves
// synchronously. The type import above is erased at build, so it adds no
// runtime reference.
const nodeRequire = createRequire(import.meta.url);
type BunDatabaseCtor = new (path: string) => Database;
let _Database: BunDatabaseCtor | undefined;
const bunDatabase = (): BunDatabaseCtor => {
  if (!_Database) {
    const spec = ['bun', 'sqlite'].join(':');
    _Database = (nodeRequire(spec) as { Database: BunDatabaseCtor }).Database;
  }
  return _Database;
};

class BunSqliteAdapter implements SqliteAdapter {
  private db: Database;
  private isOpen = true;

  constructor(path: string) {
    this.db = new (bunDatabase())(path);
  }

  get open(): boolean {
    return this.isOpen;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params) => stmt.all(...(params as never[])) as unknown[],
      get: (...params) => (stmt.get(...(params as never[])) as unknown) ?? null,
      run: (...params) => {
        const r = stmt.run(...(params as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
    };
  }

  pragma(statement: string): unknown {
    const trimmed = statement.trim();
    if (trimmed.includes('=')) {
      this.db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    return this.db.prepare(`PRAGMA ${trimmed}`).get();
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  loadExtension(path: string): void {
    this.db.loadExtension(path);
  }

  close(): void {
    if (!this.isOpen) return;
    this.db.close();
    this.isOpen = false;
  }
}

export const bunSqliteFactory: SqliteAdapterFactory = {
  open: (path: string) => new BunSqliteAdapter(path),
};
