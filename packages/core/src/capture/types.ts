// SPDX-License-Identifier: Apache-2.0

// Automatic memory capture. A conversation is normalized into these events
// (from a Claude Code transcript, a hook spool or a bench run); the extractor
// reads them and emits the moments the conversation settled something.

export type ConversationEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id?: string; output: string; is_error?: boolean }
  // A permission prompt the user answered. `reason` is what they typed when
  // they declined, if anything.
  | {
      type: 'permission';
      id?: string;
      tool: string;
      decision: 'approved' | 'denied';
      reason?: string;
    };

export interface NormalizedConversation {
  session_id: string;
  events: ConversationEvent[];
  // Global index of events[0]. Incremental capture feeds a few already-seen
  // events back as context; spans stay comparable across runs.
  offset?: number;
  // Only records triggered at or after this global index are emitted; earlier
  // events are context (the proposal an approval answers, say).
  emit_from?: number;
}

// What the extractor recognised:
//   agreed      the assistant proposed something and the user approved it
//   rejected    the user declined or reversed something, or ruled it out
//   dead-end    an attempt failed and was abandoned (optionally recovered)
//   correction  "no, use X instead"
//   constraint  never / always / must / don't touch / only …
//   decision    a decision the user stated ("we went with X")
export type SettledKind =
  | 'agreed'
  | 'rejected'
  | 'dead-end'
  | 'correction'
  | 'constraint'
  | 'decision';

export interface SettledAnchors {
  // Paths as written in the conversation (absolute tool paths included); the
  // store resolves them against the graph.
  files: string[];
  symbols: string[];
}

export interface SettledRecord {
  kind: SettledKind;
  summary: string;
  // The user's own words (trimmed). For a dead end with no user words, the
  // error and the assistant's sentence giving up on the attempt.
  rationale: string;
  anchors: SettledAnchors;
  // 0..1 — how sure the rule that fired is. Injection needs a threshold.
  confidence: number;
  // Global event indexes, inclusive.
  span: { from: number; to: number };
  // The rule that fired (debugging, fixtures).
  cue: string;
}
