// SPDX-License-Identifier: Apache-2.0
// The results manifest, scripts/bench/results/index.json: every recorded run
// with its model, vendor, price tier and mode, plus what the catalogue says
// about each model. bench:matrix rewrites it after every model; the charts
// and the by-model report read it. Built by a pure function, so the same
// results and prices always give the same file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelPricing } from './pricing.ts';
import type { BenchFile, SessionsBenchFile } from './types.ts';

export const RESULTS_DIR = resolve(import.meta.dir, 'results');
export const INDEX_PATH = join(RESULTS_DIR, 'index.json');
export const LINEUP_PATH = resolve(import.meta.dir, 'lineup.json');

// Input list price that splits the tiers, USD per million prompt tokens.
export const TIER_THRESHOLD_USD_PER_M = 1;

export type PriceTierName = 'low-cost' | 'frontier';
export type RunMode = 'qa' | 'sessions';

// What every run of every model shares; recorded in the manifest so a reader
// sees the fairness terms next to the numbers.
export const FAIRNESS = [
  'Every model gets the same system prompt, tools, tool descriptions, queries or task pairs, arms, trials and turn limit.',
  'No temperature, top_p or reasoning setting is sent: each model runs at its provider defaults. Reasoning is on by default for some models and is billed as completion tokens.',
  'max_tokens is 2048 per call for every model; a reasoning model that spends it thinking ends that call with finish_reason "length".',
  'All calls go through OpenRouter with usage accounting on; the cost is the one OpenRouter reports, or the list price when a reply omits it.',
];

export interface IndexModel {
  id: string;
  vendor: string;
  // USD per million tokens, base tier; null when the catalogue has no price.
  input_usd_per_m: number | null;
  output_usd_per_m: number | null;
  tier: PriceTierName | null;
  // The dated snapshot the catalogue resolves the id to.
  canonical_slug: string | null;
  tools: boolean | null;
  reasoning: { default_enabled: boolean; mandatory: boolean } | null;
  in_lineup: boolean;
}

export interface IndexRun {
  file: string;
  label: string;
  mode: RunMode;
  model: string;
  vendor: string;
  tier: PriceTierName | null;
  provider: string;
  started_at: string;
  finished_at: string | null;
  arms: string[];
  trials: number;
  max_turns: number;
  // Queries (qa) or task pairs (sessions) in the run.
  items: number;
  task_set: string | null;
  results: number;
  // Model ids the API reported serving the calls (the resolved snapshots).
  resolved_models: string[];
  rig: { version: string; commit: string | null; fingerprint: string };
  // Sum of the known per-run costs; `cost_unknown` runs had none.
  cost_usd: number;
  cost_unknown: number;
}

export interface BenchIndex {
  schema: 1;
  tier_threshold_usd_per_m_input: number;
  prices_as_of: string | null;
  fairness: string[];
  models: IndexModel[];
  runs: IndexRun[];
}

export type AnyBenchFile = BenchFile | SessionsBenchFile;

export const isSessionsFile = (f: AnyBenchFile): f is SessionsBenchFile =>
  'mode' in f && f.mode === 'sessions';

export const vendorOf = (model: string): string =>
  model.includes('/') ? model.split('/')[0]! : model.startsWith('claude') ? 'anthropic' : 'unknown';

// `openai/gpt-6-luna` → `openai-gpt-6-luna`, safe in a file name.
export const modelSlug = (model: string): string =>
  model.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export const tierFor = (inputUsdPerToken: number | null): PriceTierName | null =>
  inputUsdPerToken === null
    ? null
    : inputUsdPerToken * 1e6 < TIER_THRESHOLD_USD_PER_M
      ? 'low-cost'
      : 'frontier';

const perM = (usdPerToken: number): number => Math.round(usdPerToken * 1e6 * 1e6) / 1e6;

export const modelInfo = (
  id: string,
  pricing: ModelPricing | null,
  inLineup: boolean,
): IndexModel => {
  const base = pricing?.tiers[0] ?? null;
  return {
    id,
    vendor: vendorOf(id),
    input_usd_per_m: base ? perM(base.prompt) : null,
    output_usd_per_m: base ? perM(base.completion) : null,
    tier: tierFor(base?.prompt ?? null),
    canonical_slug: pricing?.canonical ?? null,
    tools: pricing?.tools ?? null,
    reasoning: pricing?.reasoning ?? null,
    in_lineup: inLineup,
  };
};

const runCosts = (f: AnyBenchFile): (number | null)[] =>
  isSessionsFile(f)
    ? f.results.map((r) =>
        (r.s1 && r.s1.cost_usd === null) || r.s2.cost_usd === null
          ? null
          : (r.s1?.cost_usd ?? 0) + r.s2.cost_usd,
      )
    : f.results.map((r) =>
        r.cost_usd === null || (r.judge && r.judge.cost_usd === null)
          ? null
          : r.cost_usd + (r.judge?.cost_usd ?? 0),
      );

// What a results file has spent so far (unknown costs count as zero).
export const spentUsd = (f: AnyBenchFile): number =>
  runCosts(f).reduce<number>((s, c) => s + (c ?? 0), 0);

export const runEntry = (file: string, f: AnyBenchFile, model: IndexModel | null): IndexRun => {
  const costs = runCosts(f);
  const resolved = isSessionsFile(f)
    ? f.results.flatMap((r) => [...(r.s1?.resolved_models ?? []), ...r.s2.resolved_models])
    : f.results.flatMap((r) => r.resolved_models);
  return {
    file,
    label: f.label,
    mode: isSessionsFile(f) ? 'sessions' : 'qa',
    model: f.model,
    vendor: vendorOf(f.model),
    tier: model?.tier ?? null,
    provider: f.provider,
    started_at: f.started_at,
    finished_at: f.finished_at,
    arms: [...f.arms],
    trials: f.trials,
    max_turns: f.max_turns,
    items: isSessionsFile(f) ? f.tasks.length : f.queries.length,
    task_set: isSessionsFile(f) ? (f.task_set ?? null) : null,
    results: f.results.length,
    resolved_models: [...new Set(resolved)].sort(),
    rig: { version: f.rig.version, commit: f.rig.commit, fingerprint: f.rig.fingerprint },
    cost_usd: Math.round(costs.reduce<number>((s, c) => s + (c ?? 0), 0) * 1e6) / 1e6,
    cost_unknown: costs.filter((c) => c === null).length,
  };
};

/**
 * The manifest for these results files. Model metadata comes from the
 * catalogue when there is one; otherwise from the previous manifest, so an
 * offline rebuild keeps the prices it had. Models are in lineup order, then
 * any other model with a run, by id; runs are by file name.
 */
export const buildIndex = (opts: {
  files: readonly { file: string; data: AnyBenchFile }[];
  catalogue: Map<string, ModelPricing> | null;
  previous: BenchIndex | null;
  lineup: readonly string[];
  // The date the catalogue was read (YYYY-MM-DD); ignored without one.
  asOf: string | null;
}): BenchIndex => {
  const ran = [...new Set(opts.files.map((f) => f.data.model))].sort();
  const ids = [...opts.lineup, ...ran.filter((m) => !opts.lineup.includes(m))];
  const prev = new Map(opts.previous?.models.map((m) => [m.id, m]) ?? []);
  const models = ids.map((id): IndexModel => {
    const inLineup = opts.lineup.includes(id);
    const fromCatalogue = opts.catalogue?.get(id);
    if (fromCatalogue) return modelInfo(id, fromCatalogue, inLineup);
    const p = prev.get(id);
    return p ? { ...p, in_lineup: inLineup } : modelInfo(id, null, inLineup);
  });
  const byId = new Map(models.map((m) => [m.id, m]));
  const runs = [...opts.files]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((f) => runEntry(f.file, f.data, byId.get(f.data.model) ?? null));
  return {
    schema: 1,
    tier_threshold_usd_per_m_input: TIER_THRESHOLD_USD_PER_M,
    prices_as_of: opts.catalogue ? opts.asOf : (opts.previous?.prices_as_of ?? null),
    fairness: [...FAIRNESS],
    models,
    runs,
  };
};

// Every results file in a directory (index.json aside), by file name.
export const loadResultsDir = (dir: string = RESULTS_DIR): { file: string; data: AnyBenchFile }[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(join(dir, file), 'utf-8')) as AnyBenchFile,
    }));

export const loadIndex = (path: string = INDEX_PATH): BenchIndex | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as BenchIndex) : null;

export const loadLineup = (path: string = LINEUP_PATH): string[] =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as { models: string[] }).models : [];
