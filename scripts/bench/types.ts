// SPDX-License-Identifier: Apache-2.0
// Shapes shared by the bench harness: queries.json, the results file, and the
// tool definitions each arm hands the model.

// Anthropic-style tool definition; the OpenRouter provider converts it to the
// OpenAI function shape on the way out.
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ArmName = 'baseline' | 'rig' | 'rig-search' | 'grep+rig';
export type ProviderName = 'openrouter' | 'anthropic';

// A pattern is a case-insensitive substring, or a regex written "/source/flags".
export type Pattern = string;

export interface Expected {
  // Every pattern must match.
  all?: Pattern[];
  // At least `any_min` (default 1) of these must match.
  any?: Pattern[];
  any_min?: number;
  // None of these may match.
  none?: Pattern[];
}

export interface Query {
  id: string;
  // 'lookup' names the symbol or file; 'natural' is phrased the way a user
  // asks, with no identifiers, so it measures search rather than grep.
  category: 'lookup' | 'natural';
  ask: string;
  // Short reference answer at the pinned commit; the LLM judge sees it.
  reference: string;
  expected: Expected;
}

export interface QueriesFile {
  target: { repo: string; url: string; commit: string; tag?: string };
  queries: Query[];
}

export interface CheckResult {
  pass: boolean;
  missing: string[];
  any_matched: string[];
  forbidden: string[];
}

export interface JudgeResult {
  verdict: 'correct' | 'incorrect' | 'error';
  reason: string;
  cost_usd: number | null;
  prompt_tokens: number;
  completion_tokens: number;
}

export type StopReason = 'answer' | 'turn_limit' | 'error';

export interface RunResult {
  query_id: string;
  arm: ArmName;
  trial: number;
  prompt_tokens: number;
  completion_tokens: number;
  // USD. OpenRouter reports it per call; on the Anthropic path it is computed
  // from list prices. null when any call's cost is unknown.
  cost_usd: number | null;
  model_calls: number;
  tool_turns: number;
  // Characters of tool output fed back to the model, per tool name.
  tool_chars: Record<string, number>;
  stop: StopReason;
  final_text: string;
  error?: string;
  resolved_models: string[];
  upstreams: string[];
  elapsed_ms: number;
  check: CheckResult;
  judge?: JudgeResult;
}

export interface RigVersion {
  version: string;
  commit: string | null;
  dirty: boolean;
  // Hash of the rig sources that shape indexing and the tool surface.
  fingerprint: string;
}

export interface BenchFile {
  schema: 2;
  label: string;
  started_at: string;
  finished_at: string | null;
  provider: ProviderName;
  model: string;
  judge_model: string | null;
  rig: RigVersion;
  target: {
    repo: string;
    commit: string | null;
    expected_commit: string;
    index: { nodes: number; files: number; rebuilt: boolean; elapsed_ms: number };
  };
  arms: ArmName[];
  trials: number;
  max_turns: number;
  queries: Query[];
  results: RunResult[];
}
