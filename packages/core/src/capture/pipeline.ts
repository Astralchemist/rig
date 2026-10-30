// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { Rig } from '../rig.ts';
import { normalizeClaudeTranscript, type ToolNames } from './claude-transcript.ts';
import { extractSettled } from './extractor.ts';
import {
  readCursor,
  readSpool,
  tailOf,
  withSessionLock,
  writeCursor,
  type CaptureCursor,
} from './state.ts';
import { storeSettled, type StoreOutcome } from './store.ts';
import type { ConversationEvent, NormalizedConversation, SettledRecord } from './types.ts';

// The capture pipeline: extract settled records from a normalized
// conversation and store them as waypoints. `rig hook` runs it on a session's
// transcript since the last cursor; the benchmark runs the same function on
// a finished conversation.

export interface CaptureOptions {
  client: string;
  searchWaitMs?: number;
  deadline?: number;
}

export interface CaptureResult {
  records: SettledRecord[];
  outcome: StoreOutcome;
}

export const captureConversation = async (
  rig: Rig,
  conv: NormalizedConversation,
  opts: CaptureOptions,
): Promise<CaptureResult> => {
  const records = extractSettled(conv);
  const outcome = await storeSettled(rig, records, {
    sessionId: conv.session_id,
    client: opts.client,
    ...(opts.searchWaitMs !== undefined ? { searchWaitMs: opts.searchWaitMs } : {}),
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
  });
  return { records, outcome };
};

// At most this much new transcript per run; the rest waits for the next one.
const READ_MAX = 4 * 1024 * 1024;

const readFrom = (path: string, offset: number): { text: string; consumed: number } => {
  const size = statSync(path).size;
  const start = offset > size ? 0 : offset;
  const len = Math.min(size - start, READ_MAX);
  if (len <= 0) return { text: '', consumed: start };
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  // Whole lines only: a line still being written is read next time.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { text: '', consumed: start };
  return { text: buf.subarray(0, lastNl + 1).toString('utf-8'), consumed: start + lastNl + 1 };
};

export interface SessionCaptureOptions extends CaptureOptions {
  projectRoot: string;
  sessionId: string;
  // The host's transcript (Claude Code JSONL). Without a readable one the
  // session's spool is used.
  transcriptPath?: string;
}

export interface SessionCaptureResult extends CaptureResult {
  // Events read this run.
  events: number;
  source: CaptureCursor['source'];
}

// Capture what a session said since the last run. Null when another process
// is capturing the same session right now (its run covers this one).
export const captureSession = (
  rig: Rig,
  opts: SessionCaptureOptions,
): Promise<SessionCaptureResult | null> =>
  withSessionLock(opts.projectRoot, opts.sessionId, async () => {
    const prev = readCursor(opts.projectRoot, opts.sessionId);
    const useTranscript = !!opts.transcriptPath && existsSync(opts.transcriptPath);
    const source: CaptureCursor['source'] = useTranscript ? 'transcript' : 'spool';
    // A cursor from the other source (or another transcript file) starts over.
    const same =
      prev &&
      prev.source === source &&
      (source === 'spool' || prev.transcript_path === opts.transcriptPath);
    const cursor: CaptureCursor = same
      ? prev
      : { source, offset: 0, event_index: 0, tail: [], updated_at: 0 };
    const toolNames: ToolNames = new Map();
    for (const e of cursor.tail) if (e.type === 'tool_call' && e.id) toolNames.set(e.id, e.name);

    let fresh: ConversationEvent[];
    let offset: number;
    if (useTranscript) {
      const r = readFrom(opts.transcriptPath!, cursor.offset);
      fresh = normalizeClaudeTranscript(r.text, toolNames);
      offset = r.consumed;
    } else {
      const all = readSpool(opts.projectRoot, opts.sessionId);
      fresh = all.slice(cursor.offset);
      offset = all.length;
    }

    const events = [...cursor.tail, ...fresh];
    const base = cursor.event_index - cursor.tail.length;
    const result = fresh.length
      ? await captureConversation(
          rig,
          { session_id: opts.sessionId, events, offset: base, emit_from: cursor.event_index },
          opts,
        )
      : { records: [], outcome: { stored: [], duplicates: [], skipped: [] } };
    writeCursor(opts.projectRoot, opts.sessionId, {
      source,
      ...(useTranscript ? { transcript_path: opts.transcriptPath! } : {}),
      offset,
      event_index: cursor.event_index + fresh.length,
      tail: tailOf(events),
      updated_at: Date.now(),
    });
    return { ...result, events: fresh.length, source };
  });
