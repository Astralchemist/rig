// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { logDebug } from './errors.ts';

// One file watcher per project, however many rig processes (MCP servers, the
// web map) have it open: only the holder of .rig/watch.lock watches and syncs.
// The holder touches the file every heartbeat. A lock is stale, and taken
// over, when its process is gone or its heartbeat is older than staleMs (a
// frozen process, or a pid reused after a reboot). The holder re-reads the
// lock on each heartbeat and steps down if someone else took it.

export const WATCH_LOCK_FILE = 'watch.lock';

export interface WatchLockOptions {
  heartbeatMs?: number;
  staleMs?: number;
  // Called (once) when a heartbeat finds the lock now belongs to someone else.
  onLost?: () => void;
}

export interface WatchLock {
  readonly path: string;
  release(): void;
}

interface LockBody {
  pid: number;
  host: string;
  token: string;
  started_at: number;
}

const readBody = (path: string): LockBody | null => {
  try {
    const body = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LockBody>;
    return typeof body.pid === 'number' && typeof body.token === 'string'
      ? (body as LockBody)
      : null;
  } catch {
    return null;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const isStale = (path: string, staleMs: number): boolean => {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return true;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  const body = readBody(path);
  // Unreadable but fresh: a holder mid-write. Leave it alone.
  if (!body) return false;
  return body.host === hostname() && !isAlive(body.pid);
};

// Create `path` with `content` only if it does not exist: write a private temp
// file, then hard-link it into place (atomic, fails with EEXIST). Filesystems
// without hard links fall back to an exclusive create.
const createExclusive = (path: string, content: string, token: string): boolean => {
  const tmp = `${path}.${token}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    try {
      writeFileSync(path, content, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
};

// Try to become the project's watcher. Returns null when a live process holds
// the lock (including another Rig instance in this process).
export const acquireWatchLock = (rigDir: string, opts: WatchLockOptions = {}): WatchLock | null => {
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const path = join(rigDir, WATCH_LOCK_FILE);
  const token = randomUUID();
  const body: LockBody = { pid: process.pid, host: hostname(), token, started_at: Date.now() };
  const content = JSON.stringify(body);

  let acquired = createExclusive(path, content, token);
  if (!acquired && isStale(path, staleMs)) {
    logDebug('Taking over stale watch lock', { path, holder: readBody(path) });
    try {
      unlinkSync(path);
    } catch {
      // another process removed it first
    }
    acquired = createExclusive(path, content, token);
  }
  if (!acquired) return null;

  const ours = (): boolean => readBody(path)?.token === token;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    process.removeListener('exit', release);
    if (ours()) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  };
  const heartbeat = setInterval(() => {
    if (!ours()) {
      release();
      opts.onLost?.();
      return;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // transient; the next beat retries
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  process.on('exit', release);
  return { path, release };
};
