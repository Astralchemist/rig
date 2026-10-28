// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { SqliteAdapter } from '@rig/core/db/adapter.ts';
import { Database } from '@rig/core/db/database.ts';

// Several processes share one .rig/rig.db: each agent's MCP server, `rig
// serve`, `rig index`. A second writer must wait for the lock, not fail.

const HOLD_MS = 500;

// Runs in a child process: take the write lock on the same file, report it,
// then sit on it so the test process has to contend.
const HOLD_LOCK = `
const { Database } = require('bun:sqlite');
const db = new Database(process.env.RIG_TEST_DB);
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO probe (who) VALUES ('child')");
console.log('locked');
Bun.sleepSync(${HOLD_MS});
db.exec('COMMIT');
`;

const holdWriteLock = async (dbPath: string): Promise<Subprocess<'ignore', 'pipe', 'pipe'>> => {
  const child = Bun.spawn([process.execPath, '-e', HOLD_LOCK], {
    env: { ...process.env, RIG_TEST_DB: dbPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  let out = '';
  while (!out.includes('locked')) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`lock holder exited early: ${await new Response(child.stderr).text()}`);
    }
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return child;
};

// Control: a connection on SQLite's default busy_timeout (0) fails at once, so
// the lock really is held while the rig write under test runs.
const expectLocked = (dbPath: string): void => {
  const bare = new BunDatabase(dbPath);
  try {
    expect(() => bare.exec("INSERT INTO probe (who) VALUES ('bare')")).toThrow(/locked|busy/i);
  } finally {
    bare.close();
  }
};

const busyTimeout = (db: Database): number | undefined => {
  const raw = db.adapter.pragma('busy_timeout') as { timeout: number } | { timeout: number }[];
  return (Array.isArray(raw) ? raw[0] : raw)?.timeout;
};

describe('Database — concurrent writers', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-db-lock-'));
    dbPath = join(dir, 'rig.db');
    db = Database.open(dbPath);
    db.adapter.exec('CREATE TABLE probe (who TEXT NOT NULL)');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = (): string[] =>
    (db.adapter.prepare('SELECT who FROM probe ORDER BY rowid').all() as { who: string }[]).map(
      (r) => r.who,
    );

  it('sets busy_timeout to 5000ms', () => {
    expect(busyTimeout(db)).toBe(5000);
  });

  it("a write waits out another process's write lock instead of failing SQLITE_BUSY", async () => {
    const child = await holdWriteLock(dbPath);
    expectLocked(dbPath);
    db.adapter.prepare("INSERT INTO probe (who) VALUES ('parent')").run();
    expect(await child.exited).toBe(0);
    expect(rows()).toEqual(['child', 'parent']);
  });

  it('transaction() takes the write lock up front, so read-then-write bodies wait too', async () => {
    // Under a deferred BEGIN the SELECT pins a read snapshot, and SQLite skips
    // the busy handler when upgrading that to a write lock, so the INSERT
    // would fail SQLITE_BUSY at once whatever busy_timeout says.
    const child = await holdWriteLock(dbPath);
    expectLocked(dbPath);
    const seen = db.adapter.transaction(() => {
      const { n } = db.adapter.prepare('SELECT count(*) AS n FROM probe').get() as { n: number };
      db.adapter.prepare("INSERT INTO probe (who) VALUES ('parent')").run();
      return n;
    })();
    expect(await child.exited).toBe(0);
    // The read already saw the child's row: the lock was taken before it ran.
    expect(seen).toBe(1);
    expect(rows()).toEqual(['child', 'parent']);
  });
});

describe('better-sqlite3 adapter (Node fallback)', () => {
  // better-sqlite3 doesn't load under Bun; a recording stand-in shows what the
  // adapter asks of the driver.
  const calls: string[] = [];
  class FakeBetterSqlite {
    open = true;
    pragma(statement: string): unknown[] {
      calls.push(`PRAGMA ${statement}`);
      return [];
    }
    transaction(fn: () => unknown): (() => unknown) & { immediate: () => unknown } {
      const begin = (sql: string) => (): unknown => (calls.push(sql), fn());
      return Object.assign(begin('BEGIN'), { immediate: begin('BEGIN IMMEDIATE') });
    }
    close(): void {}
  }
  const openAdapter = async (): Promise<SqliteAdapter> => {
    mock.module('better-sqlite3', () => ({ default: FakeBetterSqlite }));
    const { betterSqliteFactory } = await import('@rig/core/db/better-sqlite-adapter.ts');
    return betterSqliteFactory.open(':memory:');
  };

  it('sets busy_timeout to 5000ms on open', async () => {
    (await openAdapter()).close();
    expect(calls).toContain('PRAGMA busy_timeout = 5000');
  });

  it('opens transactions with BEGIN IMMEDIATE', async () => {
    const adapter = await openAdapter();
    expect(adapter.transaction(() => 42)()).toBe(42);
    expect(calls.at(-1)).toBe('BEGIN IMMEDIATE');
    adapter.close();
  });
});
