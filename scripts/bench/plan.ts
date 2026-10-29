// SPDX-License-Identifier: Apache-2.0
// Cost estimate for --dry-run: runs × an assumed per-run token profile × the
// model's price. The default profiles are rough guesses; --estimate-from
// replaces them with the per-arm means of an earlier results file.
import { priceCall, type ModelPricing } from './pricing.ts';
import type {
  ArmName,
  BenchFile,
  MemoryArmName,
  SessionOutcome,
  SessionsBenchFile,
} from './types.ts';

export interface RunProfile {
  prompt_tokens: number;
  completion_tokens: number;
  model_calls: number;
}

// Baseline re-sends grep output and file slices on every call; the rig arms
// send short node lists, rig-search sometimes a source bundle. grep+rig is
// assumed to cost about what baseline does until a run says otherwise;
// grep+rig+map pays the ~2k-token overview again on every call (the bench
// enables no prompt caching).
const GREP_RIG_PROFILE: RunProfile = {
  prompt_tokens: 60_000,
  completion_tokens: 1_500,
  model_calls: 6,
};

// grep+rig's profile with a `mapTokens` overview added to every call.
export const withOverview = (p: RunProfile, mapTokens: number): RunProfile => ({
  ...p,
  prompt_tokens: p.prompt_tokens + mapTokens * p.model_calls,
});

export const DEFAULT_PROFILES: Record<ArmName, RunProfile> = {
  baseline: { prompt_tokens: 60_000, completion_tokens: 1_500, model_calls: 6 },
  rig: { prompt_tokens: 20_000, completion_tokens: 1_000, model_calls: 5 },
  'rig-search': { prompt_tokens: 30_000, completion_tokens: 1_000, model_calls: 4 },
  'grep+rig': GREP_RIG_PROFILE,
  'grep+rig+map': withOverview(GREP_RIG_PROFILE, 2_000),
};

// A judge call: question, reference and answer in, a one-line verdict out.
export const JUDGE_PROFILE: RunProfile = {
  prompt_tokens: 1_200,
  completion_tokens: 80,
  model_calls: 1,
};

export const profilesFrom = (file: BenchFile): Partial<Record<ArmName, RunProfile>> => {
  const out: Partial<Record<ArmName, RunProfile>> = {};
  for (const arm of file.arms) {
    const rs = file.results.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    const mean = (f: (r: (typeof rs)[number]) => number) =>
      rs.reduce((s, r) => s + f(r), 0) / rs.length;
    out[arm] = {
      prompt_tokens: Math.round(mean((r) => r.prompt_tokens)),
      completion_tokens: Math.round(mean((r) => r.completion_tokens)),
      model_calls: Math.max(1, Math.round(mean((r) => r.model_calls))),
    };
  }
  return out;
};

// Price a run as `model_calls` equal calls, so a long-context tier only kicks
// in when the average call crosses it.
export const runCost = (p: ModelPricing, prof: RunProfile): number => {
  const calls = Math.max(1, prof.model_calls);
  return priceCall(p, prof.prompt_tokens / calls, prof.completion_tokens / calls) * calls;
};

export interface ArmEstimate {
  arm: ArmName;
  runs: number;
  profile: RunProfile;
  cost_usd: number | null;
}

export interface PlanEstimate {
  arms: ArmEstimate[];
  judge_cost_usd: number | null;
  total_usd: number | null;
  total_tokens: number;
}

export const estimatePlan = (opts: {
  arms: readonly ArmName[];
  runsPerArm: number;
  pricing: ModelPricing | null;
  profiles?: Partial<Record<ArmName, RunProfile>>;
  judgePricing?: ModelPricing | null;
  judge?: boolean;
  // grep+rig+map's overview budget in tokens (default 2000).
  mapTokens?: number;
}): PlanEstimate => {
  // Without a measured grep+rig+map profile, take grep+rig's (measured or
  // assumed) and add the overview to every call.
  const mapProfile = (): RunProfile =>
    withOverview(opts.profiles?.['grep+rig'] ?? GREP_RIG_PROFILE, opts.mapTokens ?? 2_000);
  const arms = opts.arms.map((arm): ArmEstimate => {
    const profile =
      opts.profiles?.[arm] ?? (arm === 'grep+rig+map' ? mapProfile() : DEFAULT_PROFILES[arm]);
    return {
      arm,
      runs: opts.runsPerArm,
      profile,
      cost_usd: opts.pricing ? runCost(opts.pricing, profile) * opts.runsPerArm : null,
    };
  });
  const judgeRuns = opts.judge ? opts.runsPerArm * opts.arms.length : 0;
  const judgeCost =
    judgeRuns === 0
      ? 0
      : opts.judgePricing
        ? runCost(opts.judgePricing, JUDGE_PROFILE) * judgeRuns
        : null;
  const costs = [...arms.map((a) => a.cost_usd), judgeCost];
  return {
    arms,
    judge_cost_usd: opts.judge ? judgeCost : null,
    total_usd: costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + c!, 0),
    total_tokens:
      arms.reduce(
        (s, a) => s + (a.profile.prompt_tokens + a.profile.completion_tokens) * a.runs,
        0,
      ) +
      judgeRuns * (JUDGE_PROFILE.prompt_tokens + JUDGE_PROFILE.completion_tokens),
  };
};

// ------------------------------------------------- multi-session memory mode

// Assumed per-session token profiles. A session-1 user message runs about one
// grep+rig question's loop (measured 2026-10-29 on Haiku 5.5: ~23k prompt,
// ~0.9k completion, ~3.4 calls), rounded up for the history every later
// message carries. Session 2 is one such question with a longer answer.
export const SESSION_PROFILES = {
  s1_per_message: { prompt_tokens: 30_000, completion_tokens: 1_200, model_calls: 4 },
  s2: { prompt_tokens: 25_000, completion_tokens: 1_000, model_calls: 4 },
  s2_grep_only: { prompt_tokens: 20_000, completion_tokens: 1_000, model_calls: 4 },
} as const satisfies Record<string, RunProfile>;

// What an arm adds to every call of a session, in tokens: extra tool
// definitions and prompt text. The waypoint calls themselves are one more
// call each (a drop in session 1, a load in session 2), priced at that
// session's average prompt plus `waypoint_output` for what a load returns.
export interface SessionOverheads {
  write_tools: number;
  read_tools: number;
  guidance: number;
  bootstrap: number;
  waypoint_output: number;
}

export interface SessionTaskShape {
  messages: number;
  oracle_tokens: number;
}

export interface SessionArmEstimate {
  arm: MemoryArmName;
  trials: number;
  s1: RunProfile | null;
  s2: RunProfile;
  cost_s1: number | null;
  cost_s2: number | null;
  cost_usd: number | null;
}

export interface SessionsPlanEstimate {
  arms: SessionArmEstimate[];
  total_usd: number | null;
  total_tokens: number;
}

const add = (p: RunProfile, perCall: number, extraCalls: number, extraPrompt = 0): RunProfile => {
  const avg = p.prompt_tokens / Math.max(1, p.model_calls);
  const calls = p.model_calls + extraCalls;
  return {
    prompt_tokens: Math.round(
      p.prompt_tokens + perCall * calls + extraCalls * (avg + perCall + extraPrompt),
    ),
    completion_tokens: p.completion_tokens + extraCalls * 200,
    model_calls: calls,
  };
};

const scale = (p: RunProfile, k: number): RunProfile => ({
  prompt_tokens: p.prompt_tokens * k,
  completion_tokens: p.completion_tokens * k,
  model_calls: p.model_calls * k,
});

// Per-arm session profiles from an earlier sessions results file.
export const sessionProfilesFrom = (
  file: SessionsBenchFile,
): Partial<Record<MemoryArmName, { s1: RunProfile | null; s2: RunProfile }>> => {
  const out: Partial<Record<MemoryArmName, { s1: RunProfile | null; s2: RunProfile }>> = {};
  for (const arm of file.arms) {
    const rs = file.results.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const prof = (ss: SessionOutcome[]): RunProfile => ({
      prompt_tokens: mean(ss.map((s) => s.prompt_tokens)),
      completion_tokens: mean(ss.map((s) => s.completion_tokens)),
      model_calls: Math.max(1, mean(ss.map((s) => s.model_calls))),
    });
    const s1s = rs.flatMap((r) => (r.s1 ? [r.s1] : []));
    out[arm] = { s1: s1s.length ? prof(s1s) : null, s2: prof(rs.map((r) => r.s2)) };
  }
  return out;
};

/**
 * Estimate a sessions run: for each arm, every task × trials, session 1 (when
 * the arm has one) priced per user message and session 2 per task, both with
 * the arm's overheads. Measured profiles, when given, replace the assumed
 * ones (and already include the overheads).
 */
export const estimateSessions = (opts: {
  arms: readonly MemoryArmName[];
  tasks: readonly SessionTaskShape[];
  trials: number;
  pricing: ModelPricing | null;
  overheads: SessionOverheads;
  measured?: Partial<Record<MemoryArmName, { s1: RunProfile | null; s2: RunProfile }>>;
}): SessionsPlanEstimate => {
  const o = opts.overheads;
  const price = (p: RunProfile | null): number | null =>
    p === null ? 0 : opts.pricing ? runCost(opts.pricing, p) : null;
  const arms = opts.arms.map((arm): SessionArmEstimate => {
    const s1Sum: RunProfile = { prompt_tokens: 0, completion_tokens: 0, model_calls: 0 };
    const s2Sum: RunProfile = { prompt_tokens: 0, completion_tokens: 0, model_calls: 0 };
    let hasS1 = false;
    let c1: number | null = 0;
    let c2: number | null = 0;
    for (const t of opts.tasks) {
      const m = opts.measured?.[arm];
      const base1 = scale(SESSION_PROFILES.s1_per_message, t.messages);
      const s1: RunProfile | null = m
        ? m.s1
        : arm === 'memory-off'
          ? base1
          : arm === 'memory-on'
            ? add(base1, o.write_tools + o.guidance, 1)
            : null;
      const s2: RunProfile = m
        ? m.s2
        : arm === 'memory-on'
          ? add(SESSION_PROFILES.s2, o.read_tools + o.bootstrap, 1, o.waypoint_output)
          : arm === 'oracle'
            ? add(SESSION_PROFILES.s2, t.oracle_tokens, 0)
            : arm === 'grep-only'
              ? { ...SESSION_PROFILES.s2_grep_only }
              : { ...SESSION_PROFILES.s2 };
      const accrue = (into: RunProfile, p: RunProfile): void => {
        into.prompt_tokens += p.prompt_tokens * opts.trials;
        into.completion_tokens += p.completion_tokens * opts.trials;
        into.model_calls += p.model_calls * opts.trials;
      };
      if (s1) {
        hasS1 = true;
        accrue(s1Sum, s1);
      }
      accrue(s2Sum, s2);
      const p1 = price(s1);
      const p2 = price(s2);
      c1 = c1 === null || p1 === null ? null : c1 + p1 * opts.trials;
      c2 = c2 === null || p2 === null ? null : c2 + p2 * opts.trials;
    }
    return {
      arm,
      trials: opts.tasks.length * opts.trials,
      s1: hasS1 ? s1Sum : null,
      s2: s2Sum,
      cost_s1: c1,
      cost_s2: c2,
      cost_usd: c1 === null || c2 === null ? null : c1 + c2,
    };
  });
  const tok = (p: RunProfile | null) => (p ? p.prompt_tokens + p.completion_tokens : 0);
  return {
    arms,
    total_usd: arms.some((a) => a.cost_usd === null)
      ? null
      : arms.reduce((s, a) => s + a.cost_usd!, 0),
    total_tokens: arms.reduce((s, a) => s + tok(a.s1) + tok(a.s2), 0),
  };
};
