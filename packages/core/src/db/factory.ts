// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapterFactory } from './adapter.ts';

// Runtime detection: prefer bun:sqlite when running under Bun, else fall back
// to the better-sqlite3 native adapter. Tests can override by passing an
// explicit factory to `Database.open`.
export const selectSqliteFactory = async (): Promise<SqliteAdapterFactory> => {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (isBun) {
    const mod = await import('./bun-adapter.ts');
    return mod.bunSqliteFactory;
  }
  const mod = await import('./better-sqlite-adapter.ts');
  return mod.betterSqliteFactory;
};

// Sync version. Throws under Node if better-sqlite3 isn't installed (the
// optional dep path) — callers needing graceful degradation should use the
// async variant.
export const selectSqliteFactorySync = (): SqliteAdapterFactory => {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (isBun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./bun-adapter.ts') as { bunSqliteFactory: SqliteAdapterFactory })
      .bunSqliteFactory;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./better-sqlite-adapter.ts') as {
    betterSqliteFactory: SqliteAdapterFactory;
  }).betterSqliteFactory;
};
