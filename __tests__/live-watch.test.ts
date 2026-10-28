// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rig } from '../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../packages/core/src/embed/deterministic-embedder.ts';
import { FileWatcher } from '../packages/core/src/watch.ts';
import { acquireWatchLock, WATCH_LOCK_FILE } from '../packages/core/src/watch-lock.ts';
import { serveWeb } from '../packages/web/src/index.ts';

// The long-running processes keep the graph live by watching the project.
// Several of them (one MCP server per agent session, the web map) can be open
// on one project; exactly one may run the file watcher.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A pid that certainly belonged to a process that has exited.
const deadPid = (): number => spawnSync(process.execPath, ['--version']).pid!;

describe('watch lock', () => {
  let dir: string;
  const lockPath = (): string => join(dir, WATCH_LOCK_FILE);
  const plant = (pid: number, token: string): void =>
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid, host: hostname(), token, started_at: Date.now() }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-watch-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a second acquire is refused until the first is released', () => {
    const first = acquireWatchLock(dir);
    expect(first).not.toBeNull();
    expect(acquireWatchLock(dir)).toBeNull();
    first!.release();
    expect(existsSync(lockPath())).toBe(false);
    const second = acquireWatchLock(dir);
    expect(second).not.toBeNull();
    second!.release();
  });

  test('a fresh lock held by a live process is respected', () => {
    plant(process.ppid, 'other');
    expect(acquireWatchLock(dir)).toBeNull();
  });

  test('a lock left by a dead process is taken over', () => {
    plant(deadPid(), 'dead');
    const lock = acquireWatchLock(dir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test('a lock whose heartbeat stopped is taken over even if its pid is alive', () => {
    plant(process.ppid, 'frozen');
    const past = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath(), past, past);
    const lock = acquireWatchLock(dir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test('the holder steps down, without deleting it, when its lock is taken over', async () => {
    let lost = 0;
    const lock = acquireWatchLock(dir, { heartbeatMs: 20, onLost: () => lost++ });
    expect(lock).not.toBeNull();
    plant(process.ppid, 'new-holder');
    await sleep(120);
    expect(lost).toBe(1);
    lock!.release();
    expect((JSON.parse(readFileSync(lockPath(), 'utf-8')) as { token: string }).token).toBe(
      'new-holder',
    );
  });
});

describe('Rig.watch across instances', () => {
  let project: string;
  const env = { force: process.env.RIG_FORCE_WATCH, off: process.env.RIG_NO_WATCH };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-watch-many-'));
    writeFileSync(join(project, 'a.ts'), `export function alpha(): number { return 1; }\n`);
    process.env.RIG_FORCE_WATCH = '1';
    delete process.env.RIG_NO_WATCH;
  });
  afterEach(() => {
    if (env.force === undefined) delete process.env.RIG_FORCE_WATCH;
    else process.env.RIG_FORCE_WATCH = env.force;
    if (env.off === undefined) delete process.env.RIG_NO_WATCH;
    else process.env.RIG_NO_WATCH = env.off;
    rmSync(project, { recursive: true, force: true });
  });

  test('one instance watches; another takes over once it stops', async () => {
    const a = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await a.indexAll();
    const b = await Rig.open(project, { embedder: new DeterministicEmbedder() });
    try {
      expect(a.watch({ debounceMs: 50 })).toBe(true);
      expect(b.watch({ debounceMs: 50, lockRetryMs: 25 })).toBe(false);
      await sleep(100);
      expect(b.isWatching()).toBe(false);

      a.unwatch();
      for (const deadline = Date.now() + 2000; !b.isWatching() && Date.now() < deadline; ) {
        await sleep(25);
      }
      expect(b.isWatching()).toBe(true);
    } finally {
      a.close();
      b.close();
    }
    expect(existsSync(join(project, '.rig', WATCH_LOCK_FILE))).toBe(false);
  });

  test('RIG_NO_WATCH=1 keeps the watcher off', async () => {
    process.env.RIG_NO_WATCH = '1';
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    try {
      expect(rig.watch()).toBe(false);
      expect(rig.isWatching()).toBe(false);
      expect(existsSync(join(project, '.rig', WATCH_LOCK_FILE))).toBe(false);
    } finally {
      rig.close();
    }
  });

  test('the web server watches by default, and not with watch: false', async () => {
    const seed = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    await seed.indexAll();
    seed.close();
    writeFileSync(
      join(project, '.rig', 'config.json'),
      JSON.stringify({ embedder: { kind: 'deterministic' } }),
    );

    const live = await serveWeb({ projectRoot: project, port: 0 });
    try {
      expect(live.rig.isWatching()).toBe(true);
    } finally {
      await live.close();
    }
    const still = await serveWeb({ projectRoot: project, port: 0, watch: false });
    try {
      expect(still.rig.isWatching()).toBe(false);
    } finally {
      await still.close();
    }
  });

  test('a .rig directory it cannot write never throws, and watching starts once it can', async () => {
    // Root ignores the permission bits; Windows does not apply them to dirs.
    if (process.getuid?.() === 0 || process.platform === 'win32') return;
    const rig = await Rig.init(project, { embedder: new DeterministicEmbedder() });
    const rigDir = join(project, '.rig');
    try {
      chmodSync(rigDir, 0o555);
      expect(rig.watch({ debounceMs: 50, lockRetryMs: 20 })).toBe(false);
      await sleep(100); // several retries hit the same error inside the timer
      expect(rig.isWatching()).toBe(false);

      chmodSync(rigDir, 0o755);
      for (const deadline = Date.now() + 2000; !rig.isWatching() && Date.now() < deadline; ) {
        await sleep(20);
      }
      expect(rig.isWatching()).toBe(true);
    } finally {
      chmodSync(rigDir, 0o755);
      rig.close();
    }
  });
});

describe('FileWatcher retries', () => {
  test('a new change gets a fresh set of retries after they ran out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-watch-retry-'));
    let calls = 0;
    let synced = 0;
    const watcher = new FileWatcher(
      dir,
      async () => {
        if (++calls <= 3) throw new Error('SQLITE_BUSY: database is locked');
        synced++;
        return { filesChanged: 0, durationMs: 0 };
      },
      { debounceMs: 10, maxRetries: 1 },
    );
    try {
      watcher.requestSync();
      await sleep(150);
      expect(calls).toBe(2); // first attempt + one retry, then it waits
      watcher.requestSync();
      await sleep(150);
      expect(calls).toBe(4);
      expect(synced).toBe(1);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
