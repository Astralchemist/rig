import type { SqliteAdapter, SqliteAdapterFactory, SqliteStatement } from './adapter.ts';

// Node fallback. Imported lazily so `bun:sqlite` users never pay the load cost,
// and so the package can ship without forcing `better-sqlite3` install (it's
// an optionalDependency — if missing, callers get a friendly error from
// `selectSqliteFactory`, not a hard crash at module load).
interface BetterSqliteCtor {
  new (path: string): BetterSqliteInstance;
}
interface BetterSqliteInstance {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStmt;
  pragma(stmt: string, opts?: { simple?: boolean }): unknown;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  loadExtension(path: string): void;
  close(): void;
  open: boolean;
}
interface BetterSqliteStmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

class BetterSqliteAdapter implements SqliteAdapter {
  private db: BetterSqliteInstance;
  private isOpen = true;

  constructor(Ctor: BetterSqliteCtor, path: string) {
    this.db = new Ctor(path);
  }

  get open(): boolean {
    return this.isOpen && this.db.open;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...p) => stmt.all(...p),
      get: (...p) => (stmt.get(...p) as unknown) ?? null,
      run: (...p) => {
        const r = stmt.run(...p);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
    };
  }

  pragma(statement: string): unknown {
    const trimmed = statement.trim();
    return this.db.pragma(trimmed);
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn as never) as unknown as () => T;
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

let cached: SqliteAdapterFactory | null = null;

export const betterSqliteFactory: SqliteAdapterFactory = {
  open: (path: string) => {
    if (!cached) {
      // require() is synchronous and the Node backend is native — keep this
      // path off the hot module-load critical chain (only fires when bun:sqlite
      // is unavailable).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = (require('better-sqlite3') as { default?: BetterSqliteCtor }) ?? {};
      const Ctor = (mod.default ?? (mod as unknown as BetterSqliteCtor));
      if (typeof Ctor !== 'function') {
        throw new Error(
          "rig: 'better-sqlite3' is missing. Install it with `npm i better-sqlite3` or run on Bun.",
        );
      }
      cached = { open: (p: string) => new BetterSqliteAdapter(Ctor, p) };
    }
    return cached.open(path);
  },
};
