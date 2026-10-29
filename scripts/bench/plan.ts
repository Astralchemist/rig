// SPDX-License-Identifier: Apache-2.0
// Cost estimate for --dry-run: runs × an assumed per-run token profile × the
// model's price. The default profiles are rough guesses; --estimate-from
// replaces them with the per-arm means of an earlier results file.
import { priceCall, type ModelPricing } from './pricing.ts';
import type { ArmName, BenchFile } from './types.ts';

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
