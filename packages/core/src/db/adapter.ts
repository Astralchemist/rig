// SPDX-License-Identifier: Apache-2.0

/**
 * How long a connection waits on another connection's lock before failing
 * with SQLITE_BUSY. Several processes share `.rig/rig.db` (each agent's MCP
 * server, `rig serve`, `rig index`), and bun:sqlite's default is 0, which
 * fails the second writer at once.
 */
export const BUSY_TIMEOUT_MS = 5000;

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | null;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteAdapter {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(statement: string): unknown;
  /**
   * Wrap `fn` in a write transaction opened with BEGIN IMMEDIATE: the write
   * lock is taken up front (waiting up to BUSY_TIMEOUT_MS), so a read-then-
   * write body can't fail SQLITE_BUSY on the lock upgrade halfway through,
   * where SQLite won't wait. Nested calls become savepoints.
   */
  transaction<T>(fn: () => T): () => T;
  /**
   * Load a native SQLite extension (e.g. sqlite-vec) from a path.
   * Seam for native escape hatches per posture A — callers can wire it now
   * even if the only current backend is bun:sqlite.
   */
  loadExtension(path: string): void;
  close(): void;
  readonly open: boolean;
}

export interface SqliteAdapterFactory {
  open(path: string): SqliteAdapter;
}
