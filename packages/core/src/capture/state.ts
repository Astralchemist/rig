// SPDX-License-Identifier: Apache-2.0
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { RIG_DIR_NAME } from '../rig-types.ts';
import { redact } from './redact.ts';
import type { ConversationEvent } from './types.ts';

// On-disk state of automatic capture, all under .rig/capture/ (never leaves
// the machine, never committed — .rig/ is the graph's own directory):
//
//   spool/<session>.jsonl   events the cheap hooks appended (prompts, tool uses)
//   cursors/<session>.json  how far capture has read, plus the events since the
//                           last user message (context for the next run)
//   cursors/<session>.lock  held while a session is being captured
//   queue/<session>.json    sessions SessionEnd handed over for later capture
//   hook.log                errors and timings; hooks never fail the agent
//
// Light on purpose: the per-prompt hooks load only this module.

export const CAPTURE_DIR = 'capture';
const TEXT_MAX = 4000;
const TAIL_MAX = 40;
const LOG_MAX = 512 * 1024;
const LOCK_STALE_MS = 120_000;

export const captureDir = (projectRoot: string): string =>
  join(projectRoot, RIG_DIR_NAME, CAPTURE_DIR);

// Session ids come from the host; keep them to a safe file name.
export const safeId = (id: string): string =>
  id
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 96) || 'session';

const spoolPath = (root: string, sid: string): string =>
  join(captureDir(root), 'spool', `${safeId(sid)}.jsonl`);
const cursorPath = (root: string, sid: string): string =>
  join(captureDir(root), 'cursors', `${safeId(sid)}.json`);
const lockPath = (root: string, sid: string): string =>
  join(captureDir(root), 'cursors', `${safeId(sid)}.lock`);
const queueDir = (root: string): string => join(captureDir(root), 'queue');
export const logPath = (root: string): string => join(captureDir(root), 'hook.log');

// The project a hook runs for: the nearest directory at or above `start`
// that has a .rig/ graph. Null when there is none (the hook does nothing).
export const findProjectRoot = (start: string): string | null => {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, RIG_DIR_NAME))) return dir;
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) return null;
    dir = up;
  }
};

// Capture is on unless RIG_CAPTURE=0|off|false, or .rig/config.json says
// { "capture": { "enabled": false } }.
export const captureEnabled = (projectRoot: string): boolean => {
  const env = process.env.RIG_CAPTURE?.toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') return false;
  try {
    const cfg = JSON.parse(
      readFileSync(join(projectRoot, RIG_DIR_NAME, 'config.json'), 'utf-8'),
    ) as {
      capture?: { enabled?: unknown };
    };
    return cfg.capture?.enabled !== false;
  } catch {
    return true;
  }
};

const ensureDir = (p: string): void => {
  mkdirSync(dirname(p), { recursive: true });
};

const atomicWriteJson = (path: string, value: unknown): void => {
  ensureDir(path);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
};

const smallInput = (input: Record<string, unknown>): Record<string, unknown> => {
  const small: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    small[k] =
      typeof v === 'string' ? redact(v.slice(0, 500)) : v && typeof v === 'object' ? '\u2026' : v;
  }
  return small;
};

// Redacted and bounded: what the spool and the cursor tail keep. A large tool
// input keeps its scalar fields, cut short (a clipped JSON string would no
// longer parse).
export const scrubEvent = (e: ConversationEvent): ConversationEvent => {
  const t = (s: string): string => redact(s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s);
  switch (e.type) {
    case 'user':
    case 'assistant':
      return { ...e, text: t(e.text) };
    case 'tool_result':
      return { ...e, output: t(e.output) };
    case 'permission':
      return e.reason ? { ...e, reason: t(e.reason) } : e;
    case 'tool_call': {
      const json = JSON.stringify(e.input);
      if (json.length > TEXT_MAX) return { ...e, input: smallInput(e.input) };
      try {
        return { ...e, input: JSON.parse(redact(json)) as Record<string, unknown> };
      } catch {
        return { ...e, input: smallInput(e.input) };
      }
    }
  }
};

// ── spool ───────────────────────────────────────────────────────────────────

export const appendSpool = (
  root: string,
  sid: string,
  events: readonly ConversationEvent[],
): void => {
  if (!events.length) return;
  const p = spoolPath(root, sid);
  ensureDir(p);
  appendFileSync(p, events.map((e) => JSON.stringify(scrubEvent(e))).join('\n') + '\n');
};

export const readSpool = (root: string, sid: string): ConversationEvent[] => {
  const p = spoolPath(root, sid);
  if (!existsSync(p)) return [];
  const out: ConversationEvent[] = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ConversationEvent);
    } catch {
      // a partial line from a concurrent append: the next run reads it whole
      break;
    }
  }
  return out;
};

// ── cursor ──────────────────────────────────────────────────────────────────

export interface CaptureCursor {
  // Where events come from: the host transcript, or the spool when there is
  // no readable transcript.
  source: 'transcript' | 'spool';
  transcript_path?: string;
  // Bytes of the transcript consumed (whole lines), or spool events consumed.
  offset: number;
  // Global index of the next event.
  event_index: number;
  // Events since the last user message, already processed: context for the
  // next run (the proposal a later "yes" answers, a pending failure).
  tail: ConversationEvent[];
  updated_at: number;
}

export const readCursor = (root: string, sid: string): CaptureCursor | null => {
  try {
    return JSON.parse(readFileSync(cursorPath(root, sid), 'utf-8')) as CaptureCursor;
  } catch {
    return null;
  }
};

export const writeCursor = (root: string, sid: string, c: CaptureCursor): void =>
  atomicWriteJson(cursorPath(root, sid), c);

// The context to carry: everything from the last user message on, bounded.
export const tailOf = (events: readonly ConversationEvent[]): ConversationEvent[] => {
  let from = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    // A host marker ("[Request interrupted…", command output) is not a turn.
    if (e.type === 'user' && !/^\s*(?:\[Request interrupted|<)/.test(e.text)) {
      from = i;
      break;
    }
  }
  return events.slice(Math.max(from, events.length - TAIL_MAX)).map(scrubEvent);
};

// ── lock ────────────────────────────────────────────────────────────────────

// Run `fn` holding the session's capture lock; null (without running it) when
// another process holds it. A lock older than LOCK_STALE_MS is taken over.
export const withSessionLock = async <T>(
  root: string,
  sid: string,
  fn: () => Promise<T>,
): Promise<T | null> => {
  const p = lockPath(root, sid);
  ensureDir(p);
  let fd: number;
  try {
    fd = openSync(p, 'wx');
  } catch {
    try {
      if (Date.now() - statSync(p).mtimeMs < LOCK_STALE_MS) return null;
      rmSync(p, { force: true });
      fd = openSync(p, 'wx');
    } catch {
      return null;
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(p, { force: true });
  }
};

// ── queue ───────────────────────────────────────────────────────────────────

export interface QueuedSession {
  session_id: string;
  transcript_path?: string;
  client: string;
  reason?: string;
  queued_at: number;
}

export const enqueueSession = (root: string, q: QueuedSession): void =>
  atomicWriteJson(join(queueDir(root), `${safeId(q.session_id)}.json`), q);

// Oldest first.
export const listQueue = (root: string): QueuedSession[] => {
  const dir = queueDir(root);
  if (!existsSync(dir)) return [];
  const out: QueuedSession[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as QueuedSession);
    } catch {
      rmSync(join(dir, f), { force: true });
    }
  }
  return out.sort((a, b) => a.queued_at - b.queued_at);
};

export const dequeueSession = (root: string, sid: string): void =>
  rmSync(join(queueDir(root), `${safeId(sid)}.json`), { force: true });

// ── log ─────────────────────────────────────────────────────────────────────

export const hookLog = (root: string, msg: string, fields: Record<string, unknown> = {}): void => {
  try {
    const p = logPath(root);
    ensureDir(p);
    if (existsSync(p) && statSync(p).size > LOG_MAX) renameSync(p, `${p}.1`);
    appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`);
  } catch {
    // logging is best effort
  }
};
