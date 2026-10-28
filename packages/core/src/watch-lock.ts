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
// lock shortly after taking it and on each heartbeat, and steps down if
// someone else took it. Nothing here throws: a lock that cannot be written is
// simply not acquired.

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

interface LockState {
  raw: string;
  mtimeMs: number;
}

const readState = (path: string): LockState | null => {
  try {
    return { raw: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
};

const isStale = (state: LockState, staleMs: number): boolean => {
  if (Date.now() - state.mtimeMs > staleMs) return true;
  let body: Partial<LockBody> | null = null;
  try {
    body = JSON.parse(state.raw) as Partial<LockBody>;
  } catch {
    // Unreadable but fresh: a holder mid-write. Leave it alone.
    return false;
  }
  if (typeof body?.pid !== 'number') return false;
  return body.host === hostname() && !isAlive(body.pid);
};

// Create `path` with `content` only if it does not exist: write a private temp
// file, then hard-link it into place (atomic, fails with EEXIST). Filesystems
// without hard links fall back to an exclusive create.
const createExclusive = (path: string, content: string, token: string): boolean => {
  const tmp = `${path}.${token}.tmp`;
  try {
    writeFileSync(tmp, content);
  } catch (e) {
    logDebug('Cannot write watch lock', { path, error: String(e) });
    return false;
  }
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
  if (!acquired) {
    const seen = readState(path);
    if (!seen || isStale(seen, staleMs)) {
      // Remove only the lock judged stale: if another process took it over in
      // the meantime, its fresh lock stays and this attempt fails.
      const now = readState(path);
      if (seen && now && now.raw === seen.raw && now.mtimeMs === seen.mtimeMs) {
        logDebug('Taking over stale watch lock', { path, holder: seen.raw });
        try {
          unlinkSync(path);
        } catch {
          // another process removed it first
        }
      }
      acquired = createExclusive(path, content, token);
    }
  }
  if (!acquired) return null;

  const ours = (): boolean => readBody(path)?.token === token;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(firstCheck);
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
  const beat = (): void => {
    if (released) return;
    if (!ours()) {
      release();
      try {
        opts.onLost?.();
      } catch (e) {
        logDebug('Watch lock onLost failed', { error: String(e) });
      }
      return;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // transient; the next beat retries
    }
  };
  // Two processes taking over the same stale lock at once is still possible
  // in a narrow window; an early check makes the loser step down quickly.
  const firstCheck = setTimeout(beat, Math.min(1000, heartbeatMs));
  firstCheck.unref?.();
  const heartbeat = setInterval(beat, heartbeatMs);
  heartbeat.unref?.();
  process.on('exit', release);
  return { path, release };
};
