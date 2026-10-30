// SPDX-License-Identifier: Apache-2.0
import type { ConversationEvent } from './types.ts';

// Claude Code transcript (JSONL, one entry per line) → normalized events.
//
// Entries that matter: `type: "user"` with `message.content` as a string
// (what the user typed) or an array of `text` / `tool_result` blocks, and
// `type: "assistant"` with `text` / `tool_use` blocks. Meta entries
// (isMeta: injected reminders, command output), sidechains (sub-agents) and
// every other entry type (summaries, snapshots, titles, modes) are skipped.
//
// The transcript records a declined permission prompt as the tool's result:
// "The user doesn't want to proceed with this tool use. …", followed by
// "the user said:\n<their words>" when they typed a reason. Approvals leave
// no trace, so the transcript yields only denials.

const OUTPUT_MAX = 8000;
const DENIED = /^The user doesn't want to (?:proceed with|take) this (?:tool use|action)/;
const DENIED_REASON = /the user said:\s*\n([\s\S]*)$/i;

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Entry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

const clipOutput = (s: string): string =>
  s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX / 2)}\n…\n${s.slice(-OUTPUT_MAX / 2)}` : s;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      c && typeof c === 'object' && (c as Block).type === 'text' ? ((c as Block).text ?? '') : '',
    )
    .filter(Boolean)
    .join('\n');
};

// Tool names by tool_use id, so a denial can say which tool it declined.
export type ToolNames = Map<string, string>;

export const normalizeClaudeEntry = (entry: unknown, toolNames: ToolNames): ConversationEvent[] => {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as Entry;
  if (e.isMeta || e.isSidechain || !e.message) return [];
  const content = e.message.content;
  const out: ConversationEvent[] = [];
  if (e.type === 'user') {
    if (typeof content === 'string') {
      if (content.trim()) out.push({ type: 'user', text: content });
      return out;
    }
    if (!Array.isArray(content)) return out;
    const typed: string[] = [];
    for (const raw of content as Block[]) {
      if (raw?.type === 'text' && raw.text?.trim()) typed.push(raw.text);
      if (raw?.type !== 'tool_result') continue;
      const id = raw.tool_use_id;
      const output = textOf(raw.content);
      if (DENIED.test(output.trim())) {
        const reason = DENIED_REASON.exec(output)?.[1]?.trim();
        out.push({
          type: 'permission',
          ...(id ? { id } : {}),
          tool: (id && toolNames.get(id)) || 'tool',
          decision: 'denied',
          ...(reason ? { reason } : {}),
        });
        continue;
      }
      out.push({
        type: 'tool_result',
        ...(id ? { id } : {}),
        output: clipOutput(output),
        ...(raw.is_error ? { is_error: true } : {}),
      });
    }
    if (typed.length) out.push({ type: 'user', text: typed.join('\n') });
    return out;
  }
  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const raw of content as Block[]) {
      if (raw?.type === 'text' && raw.text?.trim()) out.push({ type: 'assistant', text: raw.text });
      if (raw?.type === 'tool_use' && raw.name) {
        if (raw.id) toolNames.set(raw.id, raw.name);
        out.push({
          type: 'tool_call',
          ...(raw.id ? { id: raw.id } : {}),
          name: raw.name,
          input:
            raw.input && typeof raw.input === 'object'
              ? (raw.input as Record<string, unknown>)
              : {},
        });
      }
    }
  }
  return out;
};

// Parse JSONL text; a line that is not JSON (a partial last line) is skipped.
export const normalizeClaudeTranscript = (
  text: string,
  toolNames: ToolNames = new Map(),
): ConversationEvent[] => {
  const out: ConversationEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    out.push(...normalizeClaudeEntry(entry, toolNames));
  }
  return out;
};
