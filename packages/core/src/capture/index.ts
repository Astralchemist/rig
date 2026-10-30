// SPDX-License-Identifier: Apache-2.0
// Automatic memory capture: extract what a conversation settled, store it as
// waypoints, and brief the next session. See README "Automatic capture".
export { extractSettled } from './extractor.ts';
export { redact, hasSecret } from './redact.ts';
export { storeSettled, WAYPOINT_KIND_OF, lexicalSimilarity } from './store.ts';
export type { StoreOptions, StoreOutcome, StoredRecord } from './store.ts';
export { captureConversation, captureSession } from './pipeline.ts';
export type { CaptureOptions, CaptureResult, SessionCaptureResult } from './pipeline.ts';
export { buildBrief, BRIEF_MAX } from './brief.ts';
export type { BriefOptions } from './brief.ts';
export { INJECT_THRESHOLD, INJECTABLE_KINDS, isInjectable, isSurfaceable } from './trust.ts';
export { normalizeClaudeTranscript, normalizeClaudeEntry } from './claude-transcript.ts';
export type {
  ConversationEvent,
  NormalizedConversation,
  SettledAnchors,
  SettledKind,
  SettledRecord,
} from './types.ts';
