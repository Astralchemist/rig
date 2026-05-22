export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | null;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteAdapter {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Load a native SQLite extension (e.g. sqlite-vec) from a path.
   * Seam for native escape hatches per posture A — Phase 0 stub is a no-op
   * but the surface exists so callers can be wired now.
   */
  loadExtension(path: string): void;
  close(): void;
}

export interface SqliteAdapterFactory {
  open(path: string): SqliteAdapter;
}
