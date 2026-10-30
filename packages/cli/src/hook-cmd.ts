// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendSpool,
  captureDir,
  captureEnabled,
  dequeueSession,
  enqueueSession,
  findProjectRoot,
  hookLog,
  listQueue,
  safeId,
} from '@rig/core/capture/state.ts';
import type { ConversationEvent } from '@rig/core/capture/types.ts';
import { parseArgs } from './install/args.ts';

// `rig hook <event> [--client claude]` — the host's hook entry point. Reads
// the hook's JSON on stdin (https://code.claude.com/docs/en/hooks):
//
//   UserPromptSubmit, PostToolUse   append to the session's spool (cheap)
//   Stop, PreCompact                capture the transcript since the cursor
//   SessionEnd                      queue the session for capture (1.5s budget)
//   SessionStart                    drain the queue briefly, then print the
//                                   brief as additionalContext
//
// Never fails the agent: every error goes to .rig/capture/hook.log and the
// exit code is 0. Outside a rig project, or with capture switched off, it does
// nothing. Only this file and capture/state.ts load for the cheap events; the
// graph is opened only for capture and the brief.

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_output?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
}

// Stop / PreCompact: total budget, and how long one dedupe search waits for
// the embedding model.
const CAPTURE_BUDGET_MS = 20_000;
const CAPTURE_SEARCH_WAIT_MS = 1500;
// SessionStart: queued sessions are captured for at most this long (keyword
// dedupe only), so the brief is never late.
const DRAIN_BUDGET_MS = 1500;
const SPOOL_TTL_MS = 7 * 86_400_000;

const readStdin = async (): Promise<HookInput> => {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  return v && typeof v === 'object' ? (v as HookInput) : {};
};

const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const toolEvents = (input: HookInput): ConversationEvent[] => {
  if (!input.tool_name) return [];
  const id = input.tool_use_id;
  const response = input.tool_response ?? input.tool_output;
  const isError =
    !!response &&
    typeof response === 'object' &&
    ((response as { is_error?: unknown }).is_error === true ||
      (response as { success?: unknown }).success === false);
  return [
    {
      type: 'tool_call',
      ...(id ? { id } : {}),
      name: input.tool_name,
      input:
        input.tool_input && typeof input.tool_input === 'object'
          ? (input.tool_input as Record<string, unknown>)
          : {},
    },
    {
      type: 'tool_result',
      ...(id ? { id } : {}),
      output: asText(response),
      ...(isError ? { is_error: true } : {}),
    },
  ];
};

const withBudget = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Files with uncommitted changes: what this session is likely to touch.
const changedFiles = (root: string): string[] => {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 500,
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.slice(3).trim().split(' -> ').at(-1) ?? '')
    .filter(Boolean);
};

const pruneSpool = (root: string): void => {
  const dir = join(captureDir(root), 'spool');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (Date.now() - statSync(p).mtimeMs > SPOOL_TTL_MS) rmSync(p, { force: true });
  }
};

const runCapture = async (
  root: string,
  input: HookInput,
  client: string,
  out: Record<string, unknown>,
): Promise<void> => {
  const sid = input.session_id;
  if (!sid) return;
  const transcript =
    input.transcript_path && existsSync(input.transcript_path) ? input.transcript_path : undefined;
  if (!transcript && input.last_assistant_message) {
    appendSpool(root, sid, [{ type: 'assistant', text: input.last_assistant_message }]);
  }
  const { Rig } = await import('@rig/core');
  const { captureSession } = await import('@rig/core/capture/pipeline.ts');
  const rig = await Rig.open(root);
  try {
    const r = await captureSession(rig, {
      projectRoot: root,
      sessionId: sid,
      client,
      ...(transcript ? { transcriptPath: transcript } : {}),
      searchWaitMs: CAPTURE_SEARCH_WAIT_MS,
      deadline: Date.now() + CAPTURE_BUDGET_MS,
    });
    if (r) {
      Object.assign(out, {
        events: r.events,
        records: r.records.length,
        stored: r.outcome.stored.length,
        duplicates: r.outcome.duplicates.length,
      });
    } else out.locked = true;
    // Let the background embeds of what was stored finish, within reason;
    // the next sync embeds anything left.
    await withBudget(rig.whenIdle(), 5000);
  } finally {
    rig.close();
  }
};

const runSessionStart = async (
  root: string,
  input: HookInput,
  client: string,
  out: Record<string, unknown>,
): Promise<void> => {
  const { Rig } = await import('@rig/core');
  const { captureSession } = await import('@rig/core/capture/pipeline.ts');
  const { buildBrief } = await import('@rig/core/capture/brief.ts');
  const rig = await Rig.open(root);
  try {
    const until = Date.now() + DRAIN_BUDGET_MS;
    let drained = 0;
    for (const q of listQueue(root)) {
      if (Date.now() > until) break;
      const r = await captureSession(rig, {
        projectRoot: root,
        sessionId: q.session_id,
        client: q.client,
        ...(q.transcript_path ? { transcriptPath: q.transcript_path } : {}),
        searchWaitMs: 0,
        deadline: until,
      });
      if (r && !r.outcome.skipped.length) {
        dequeueSession(root, q.session_id);
        rmSync(join(captureDir(root), 'spool', `${safeId(q.session_id)}.jsonl`), { force: true });
        drained++;
      }
    }
    out.drained = drained;
    // B6 handoff. After a compaction, keep its summary's current work,
    // pending tasks and next step for whichever session comes next; on any
    // other start, deliver another session's handoff once, ahead of the brief.
    const handoff = await import('@rig/core/handoff/handoff.ts');
    let handoffText = '';
    const sid = input.session_id;
    if (input.source === 'compact' && input.transcript_path && sid) {
      let summary = handoff.latestCompactSummary(input.transcript_path);
      if (!summary) {
        // The transcript is written asynchronously; give it a moment.
        await new Promise((r) => setTimeout(r, 400));
        summary = handoff.latestCompactSummary(input.transcript_path);
      }
      const parts = summary ? handoff.handoffFromSummary(summary) : null;
      if (parts) {
        const files = changedFiles(root);
        out.handoff_written = !!handoff.writeHandoff(root, {
          ...parts,
          session_id: sid,
          client,
          source: 'compact',
          files,
        });
      }
    } else if (sid) {
      const h = handoff.takeHandoff(root, sid);
      if (h) {
        handoffText = handoff.renderHandoff(h, root);
        out.handoff_delivered = h.session_id;
      }
    }
    const brief = buildBrief(rig, { focusFiles: changedFiles(root) });
    out.brief_chars = brief.length;
    const context = [handoffText, brief].filter(Boolean).join('\n\n');
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
        }) + '\n',
      );
    }
  } finally {
    rig.close();
  }
  void client;
};

export async function runHook(cwd: string): Promise<void> {
  const started = performance.now();
  const args = parseArgs(process.argv.slice(3), ['--client']);
  const event = args.positionals[0] ?? '';
  const client = args.values.get('--client') ?? 'claude';
  let root: string | null = null;
  const fields: Record<string, unknown> = { event };
  try {
    let input: HookInput;
    try {
      input = await readStdin();
    } catch (e) {
      // Unreadable input: still log it in the project the host named.
      root = findProjectRoot(process.env.CLAUDE_PROJECT_DIR || cwd);
      throw e;
    }
    root = findProjectRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd || cwd);
    if (!root || !captureEnabled(root)) process.exit(0);
    const sid = input.session_id;
    switch (event) {
      case 'UserPromptSubmit':
        if (sid && input.prompt) appendSpool(root, sid, [{ type: 'user', text: input.prompt }]);
        break;
      case 'PostToolUse':
        if (sid) appendSpool(root, sid, toolEvents(input));
        break;
      case 'Stop':
      case 'PreCompact':
        await runCapture(root, input, client, fields);
        break;
      case 'SessionEnd':
        if (sid) {
          enqueueSession(root, {
            session_id: sid,
            client,
            queued_at: Date.now(),
            ...(input.transcript_path ? { transcript_path: input.transcript_path } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          });
        }
        break;
      case 'SessionStart':
        pruneSpool(root);
        await runSessionStart(root, input, client, fields);
        break;
      default:
        fields.ignored = true;
    }
  } catch (e) {
    if (root)
      hookLog(root, 'error', { ...fields, error: e instanceof Error ? e.message : String(e) });
  }
  if (root) hookLog(root, 'hook', { ...fields, ms: Math.round(performance.now() - started) });
  process.exit(0);
}
