// SPDX-License-Identifier: Apache-2.0
// bench:matrix: the same bench, model after model. Every model gets one
// bench:run with identical flags (prompts, tools, arms, trials, turn limit;
// no sampling settings), labelled <mode>-<model-slug>, so its results file is
// <date>-<mode>-<model-slug>.json. Before each model the runner prices it from
// OpenRouter's catalogue and stops if the spend so far plus that estimate
// would pass --budget-usd; the child run also gets the remaining budget as a
// hard cap. After each model it rewrites results/index.json. See README.md.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArms } from './arms.ts';
import {
  estimatePlan,
  estimateSessions,
  profilesFrom,
  sessionProfilesFrom,
  type RunProfile,
} from './plan.ts';
import { fetchCatalogue, type ModelPricing } from './pricing.ts';
import { EXIT_INSUFFICIENT_CREDITS } from './providers.ts';
import {
  INDEX_PATH,
  LINEUP_PATH,
  RESULTS_DIR,
  buildIndex,
  loadIndex,
  loadLineup,
  loadResultsDir,
  modelInfo,
  modelSlug,
  spentUsd,
  type AnyBenchFile,
  type IndexModel,
  type RunMode,
} from './models.ts';
import { SESSIONS_PATH, loadSessionsFile, parseMemoryArms, selectTasks } from './sessions.ts';
import { sessionOverheads, taskShapes } from './sessions-run.ts';
import type { BenchFile, QueriesFile, SessionsBenchFile } from './types.ts';

// Per call, as bench:run sends it; the completion ceiling multiplies it out.
export const MAX_TOKENS = 2048;
export const QA_DEFAULT_ARMS = ['baseline', 'grep+rig'];

const USAGE = `usage: bun run bench:matrix --models <ids|lineup> --mode qa|sessions [options]
  --models <list>          comma-separated OpenRouter ids, or "lineup" for scripts/bench/lineup.json
  --mode qa|sessions       single-shot questions, or the multi-session memory task pairs
  --arms <list>            as bench:run (default qa: ${QA_DEFAULT_ARMS.join(',')}; sessions: bench:run's default)
  --trials <n>             trials per (item, arm) (default 3)
  --task-set <name>        sessions: one task set (default: all 20 tasks)
  --tasks <ids>            sessions: a subset of task ids
  --queries <ids>          qa: a subset of query ids
  --max-turns <n>          as bench:run (default 12)
  --budget-usd <x>         required for a real run: never start a model whose estimate would
                           take the spend past this; each run is capped at what remains
  --estimate-from <files>  earlier results (comma-separated, or repeat the flag) whose
                           per-arm token means replace the assumed profiles
  --dry-run                print the per-model and total estimate, run nothing
  --reindex                rebuild results/index.json from the results files and exit
  --repo <path>            passed to bench:run`;

// ---------------------------------------------------------------- estimates

export interface ModelPlan {
  model: string;
  info: IndexModel;
  // Why the model can't run here, or null.
  problem: string | null;
  label: string;
  estimate_usd: number | null;
  // The same plan with every call's completion at max_tokens: what reasoning
  // models that think up to the cap would cost.
  ceiling_usd: number | null;
  tokens: number;
}

export interface MatrixSpec {
  mode: RunMode;
  arms: string[];
  trials: number;
  // Queries (qa) or task pairs (sessions) per arm.
  items: number;
  sessionTasks?: ReturnType<typeof taskShapes>;
  qaProfiles?: Partial<Record<string, RunProfile>>;
  sessionProfiles?: Partial<Record<string, { s1: RunProfile | null; s2: RunProfile }>>;
}

const capped = (p: RunProfile): RunProfile => ({
  ...p,
  completion_tokens: Math.max(p.completion_tokens, p.model_calls * MAX_TOKENS),
});

export const compatProblem = (
  model: string,
  pricing: ModelPricing | null,
  haveCatalogue: boolean,
): string | null => {
  if (!haveCatalogue) return 'catalogue unreachable: no price, no tool-support check';
  if (!pricing) return `${model} is not in the OpenRouter catalogue`;
  if (pricing.tools === false) return 'no tool calling (catalogue lists no "tools" parameter)';
  return null;
};

export const estimateModel = (
  spec: MatrixSpec,
  pricing: ModelPricing | null,
): { estimate: number | null; ceiling: number | null; tokens: number } => {
  if (spec.mode === 'qa') {
    const arms = spec.arms as Parameters<typeof estimatePlan>[0]['arms'];
    const runsPerArm = spec.items * spec.trials;
    const est = estimatePlan({
      arms,
      runsPerArm,
      pricing,
      ...(spec.qaProfiles ? { profiles: spec.qaProfiles } : {}),
    });
    const ceil = estimatePlan({
      arms,
      runsPerArm,
      pricing,
      profiles: Object.fromEntries(est.arms.map((a) => [a.arm, capped(a.profile)])),
    });
    return { estimate: est.total_usd, ceiling: ceil.total_usd, tokens: est.total_tokens };
  }
  const arms = spec.arms as Parameters<typeof estimateSessions>[0]['arms'];
  const base = {
    arms,
    tasks: spec.sessionTasks ?? [],
    trials: spec.trials,
    pricing,
    overheads: sessionOverheads(),
  };
  const est = estimateSessions({
    ...base,
    ...(spec.sessionProfiles ? { measured: spec.sessionProfiles } : {}),
  });
  // Per-session means for the ceiling: the estimate's sums over trials.
  const n = (spec.sessionTasks?.length ?? 0) * spec.trials || 1;
  const mean = (p: RunProfile): RunProfile => ({
    prompt_tokens: p.prompt_tokens / n,
    completion_tokens: p.completion_tokens / n,
    model_calls: p.model_calls / n,
  });
  const ceil = estimateSessions({
    ...base,
    measured: Object.fromEntries(
      est.arms.map((a) => [
        a.arm,
        { s1: a.s1 ? capped(mean(a.s1)) : null, s2: capped(mean(a.s2)) },
      ]),
    ),
  });
  return { estimate: est.total_usd, ceiling: ceil.total_usd, tokens: est.total_tokens };
};

export const planMatrix = (
  models: readonly string[],
  spec: MatrixSpec,
  catalogue: Map<string, ModelPricing> | null,
  lineup: readonly string[] = [],
): ModelPlan[] =>
  models.map((model): ModelPlan => {
    const pricing = catalogue?.get(model) ?? null;
    const e = estimateModel(spec, pricing);
    return {
      model,
      info: modelInfo(model, pricing, lineup.includes(model)),
      problem: compatProblem(model, pricing, catalogue !== null),
      label: `${spec.mode}-${modelSlug(model)}`,
      estimate_usd: e.estimate,
      ceiling_usd: e.ceiling,
      tokens: e.tokens,
    };
  });

// The guard: a model starts only if what is spent plus its estimate fits.
export const fitsBudget = (spent: number, estimate: number | null, budget: number): boolean =>
  estimate !== null && spent + estimate <= budget;

const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(2)}`);

export const dryRunLines = (
  plans: readonly ModelPlan[],
  spec: MatrixSpec,
  budget: number | null,
  estimateFrom: readonly string[],
): string[] => {
  const runs = spec.items * spec.trials * spec.arms.length;
  const L = [
    `# rig bench — matrix dry run (${spec.mode})`,
    '',
    `arms: ${spec.arms.join(', ')}; ${spec.items} ${spec.mode === 'qa' ? 'queries' : 'task pairs'} × ${spec.trials} trials = ${runs} ${spec.mode === 'qa' ? 'runs' : 'trials'} per model`,
    `profiles: ${estimateFrom.length ? `per-arm means from ${estimateFrom.join(', ')}` : 'assumed (no --estimate-from)'}`,
    `ceiling: the same plan with every model call's completion at max_tokens (${MAX_TOKENS.toLocaleString('en-US')})`,
    '',
    '| model | tier | $ / M in · out | tools | reasoning default | tokens | estimate | ceiling |',
    '|---|---|---:|---|---|---:|---:|---:|',
  ];
  for (const p of plans) {
    const i = p.info;
    const reasoning = i.reasoning
      ? i.reasoning.mandatory
        ? 'always on'
        : i.reasoning.default_enabled
          ? 'on'
          : 'off'
      : '–';
    L.push(
      `| \`${p.model}\` | ${i.tier ?? '–'} | ${i.input_usd_per_m === null ? '–' : `${i.input_usd_per_m.toFixed(3)} · ${i.output_usd_per_m!.toFixed(3)}`} | ${i.tools === null ? '?' : i.tools ? 'yes' : '**no**'} | ${reasoning} | ${(p.tokens / 1e6).toFixed(2)}M | ${usd(p.estimate_usd)} | ${usd(p.ceiling_usd)} |`,
    );
  }
  const sum = (f: (p: ModelPlan) => number | null): number | null =>
    plans.some((p) => f(p) === null) ? null : plans.reduce((s, p) => s + f(p)!, 0);
  const tiers = ['low-cost', 'frontier'] as const;
  for (const t of tiers) {
    const ps = plans.filter((p) => p.info.tier === t);
    if (ps.length === 0) continue;
    const e = ps.some((p) => p.estimate_usd === null)
      ? null
      : ps.reduce((s, p) => s + p.estimate_usd!, 0);
    const c = ps.some((p) => p.ceiling_usd === null)
      ? null
      : ps.reduce((s, p) => s + p.ceiling_usd!, 0);
    L.push(`| **${t} subtotal** (${ps.length}) | | | | | | **${usd(e)}** | **${usd(c)}** |`);
  }
  L.push(
    `| **total** (${plans.length} models) | | | | | ${(plans.reduce((s, p) => s + p.tokens, 0) / 1e6).toFixed(2)}M | **${usd(sum((p) => p.estimate_usd))}** | **${usd(sum((p) => p.ceiling_usd))}** |`,
  );
  const problems = plans.filter((p) => p.problem);
  if (problems.length) {
    L.push('', 'cannot run:', ...problems.map((p) => `  ${p.model}: ${p.problem}`));
  }
  if (budget !== null) {
    let spent = 0;
    const fit: string[] = [];
    for (const p of plans) {
      if (!fitsBudget(spent, p.estimate_usd, budget)) break;
      spent += p.estimate_usd!;
      fit.push(p.model);
    }
    L.push(
      '',
      `budget ${usd(budget)}: at the estimates, ${fit.length}/${plans.length} models run before the guard stops` +
        (fit.length < plans.length ? ` (next: ${plans[fit.length]!.model})` : ''),
    );
  }
  return L;
};

// ---------------------------------------------------------------- the run

export interface MatrixDeps {
  // Runs bench:run with these arguments; resolves to its exit code.
  runBench: (args: string[]) => Promise<number>;
  readResults: (path: string) => AnyBenchFile | null;
  writeIndex: () => void;
  log: (line: string) => void;
  date: string;
  exists: (path: string) => boolean;
  // The account's remaining balance in USD, checked before each model.
  balance?: () => Promise<number>;
}

export interface MatrixOutcome {
  model: string;
  // aborted-credits: the account ran dry mid-run; its file is marked aborted.
  // skipped-credits: the balance was already below this model's estimate.
  // not-run: never started because an earlier model was aborted.
  status: 'ran' | 'failed' | 'aborted-credits' | 'skipped-budget' | 'skipped-credits' | 'not-run';
  out: string | null;
  spent_usd: number;
}

// ---------------------------------------------------------------- credits

export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

export interface Balance {
  credits: number;
  usage: number;
  balance: number;
}

/** The key's account balance: total credits bought minus total usage. */
export const fetchBalance = async (
  apiKey: string,
  doFetch: typeof fetch = fetch,
): Promise<Balance> => {
  const res = await doFetch(OPENROUTER_CREDITS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`GET ${OPENROUTER_CREDITS_URL}: HTTP ${res.status}: ${text.slice(0, 200)}`);
  let data: { total_credits?: unknown; total_usage?: unknown } | undefined;
  try {
    data = (JSON.parse(text) as { data?: typeof data }).data;
  } catch {
    data = undefined;
  }
  const credits = Number(data?.total_credits);
  const usage = Number(data?.total_usage);
  if (
    data?.total_credits == null ||
    data?.total_usage == null ||
    !Number.isFinite(credits) ||
    !Number.isFinite(usage)
  ) {
    throw new Error(
      `GET ${OPENROUTER_CREDITS_URL}: no total_credits / total_usage in ${text.slice(0, 200)}`,
    );
  }
  return { credits, usage, balance: credits - usage };
};

// What a matrix needs up front: the whole plan's estimate, or the budget when
// that is lower (the guard stops there). null when a model can't be priced.
export const neededUsd = (plans: readonly ModelPlan[], budget: number | null): number | null => {
  if (plans.some((p) => p.estimate_usd === null)) return null;
  const total = plans.reduce((s, p) => s + p.estimate_usd!, 0);
  return budget === null ? total : Math.min(budget, total);
};

/** Why the balance can't cover `needed`, with the top-up it takes; or null. */
export const creditShortfall = (b: Balance, needed: number): string | null => {
  if (b.balance > 0 && b.balance >= needed) return null;
  const short = Math.ceil((needed - b.balance) * 100) / 100;
  return (
    `OpenRouter balance is $${b.balance.toFixed(2)} (credits $${b.credits.toFixed(2)} − usage $${b.usage.toFixed(2)}), ` +
    `${b.balance < 0 ? 'negative' : 'below'} the $${needed.toFixed(2)} this matrix needs: add at least $${Math.max(short, 0.01).toFixed(2)}.`
  );
};

/** The results path bench:run would pick for this label, made explicit. */
export const outPathFor = (
  label: string,
  date: string,
  exists: (p: string) => boolean,
  dir = RESULTS_DIR,
): string => {
  let p = join(dir, `${date}-${label}.json`);
  for (let n = 2; exists(p); n++) p = join(dir, `${date}-${label}-${n}.json`);
  return p;
};

/**
 * Run every plan in order under the budget. Identical flags for every model;
 * only --model, --label, --out and the remaining-budget cap differ.
 */
export const runMatrix = async (
  plans: readonly ModelPlan[],
  shared: readonly string[],
  budget: number,
  deps: MatrixDeps,
): Promise<MatrixOutcome[]> => {
  const out: MatrixOutcome[] = [];
  let spent = 0;
  const rest = (from: number, status: MatrixOutcome['status']) => {
    for (const q of plans.slice(from))
      out.push({ model: q.model, status, out: null, spent_usd: 0 });
  };
  for (const [i, p] of plans.entries()) {
    if (deps.balance) {
      const left = await deps.balance();
      if (p.estimate_usd === null || left < p.estimate_usd) {
        deps.log(
          `matrix: stopping before ${p.model}: balance $${left.toFixed(2)} < estimate ${usd(p.estimate_usd)}; add credits and rerun the rest`,
        );
        rest(i, 'skipped-credits');
        break;
      }
    }
    if (!fitsBudget(spent, p.estimate_usd, budget)) {
      deps.log(
        `matrix: stopping before ${p.model}: spent ${usd(spent)} + estimate ${usd(p.estimate_usd)} > budget ${usd(budget)}`,
      );
      for (const q of plans.slice(i))
        out.push({ model: q.model, status: 'skipped-budget', out: null, spent_usd: 0 });
      break;
    }
    const path = outPathFor(p.label, deps.date, deps.exists);
    const remaining = budget - spent;
    deps.log(
      `matrix: ${p.model} (estimate ${usd(p.estimate_usd)}, ${usd(remaining)} of budget left) → ${path}`,
    );
    const code = await deps.runBench([
      ...shared,
      '--model',
      p.model,
      '--label',
      p.label,
      '--out',
      path,
      '--max-spend-usd',
      remaining.toFixed(6),
    ]);
    const file = deps.readResults(path);
    const cost = file ? spentUsd(file) : 0;
    spent += cost;
    // Out of credits: this model is incomplete and every later one would
    // fail the same way, so the matrix stops here.
    const aborted = code === EXIT_INSUFFICIENT_CREDITS || file?.aborted === 'insufficient_credits';
    out.push({
      model: p.model,
      status: aborted ? 'aborted-credits' : code === 0 ? 'ran' : 'failed',
      out: file ? path : null,
      spent_usd: cost,
    });
    deps.writeIndex();
    if (aborted) {
      deps.log(
        `matrix: ${p.model} stopped: the account is out of credits (spent ${usd(cost)}); stopping the matrix`,
      );
      rest(i + 1, 'not-run');
      break;
    }
    deps.log(`matrix: ${p.model} ${code === 0 ? 'done' : `exited ${code}`}, spent ${usd(cost)}`);
    if (spent >= budget) {
      for (const q of plans.slice(i + 1))
        out.push({ model: q.model, status: 'skipped-budget', out: null, spent_usd: 0 });
      deps.log(`matrix: budget ${usd(budget)} spent; stopping`);
      break;
    }
  }
  return out;
};

// ---------------------------------------------------------------- CLI

const pooled = <T extends { arms: unknown[]; results: unknown[] }>(files: T[]): T => ({
  ...files[0]!,
  arms: [...new Set(files.flatMap((f) => f.arms))],
  results: files.flatMap((f) => f.results),
});

export const rebuildIndex = (catalogue: Map<string, ModelPricing> | null, date: string): void => {
  const index = buildIndex({
    files: loadResultsDir(),
    catalogue,
    previous: loadIndex(),
    lineup: loadLineup(),
    asOf: date,
  });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const flag = (n: string): boolean => argv.includes(n);
  const values = (n: string): string[] =>
    argv.flatMap((a, i) => (a === n && argv[i + 1] !== undefined ? [argv[i + 1]!] : []));
  const value = (n: string): string | undefined => values(n)[0];
  const log = (line: string): void => void process.stderr.write(line + '\n');
  const date = new Date().toISOString().slice(0, 10);
  if (flag('--help') || flag('-h')) return void console.log(USAGE);

  const catalogue = await fetchCatalogue();
  if (flag('--reindex')) {
    rebuildIndex(catalogue, date);
    console.log(`wrote ${INDEX_PATH}${catalogue ? '' : ' (catalogue unreachable; prices kept)'}`);
    return;
  }

  const mode = value('--mode');
  if (mode !== 'qa' && mode !== 'sessions')
    throw new Error(`--mode must be qa or sessions\n${USAGE}`);
  const rawModels = value('--models');
  if (!rawModels) throw new Error(`--models is required\n${USAGE}`);
  const lineup = loadLineup();
  const models = rawModels === 'lineup' ? lineup : rawModels.split(',').map((s) => s.trim());
  if (models.length === 0) throw new Error(`no models (lineup: ${LINEUP_PATH})`);
  const trials = Number.parseInt(value('--trials') ?? '3', 10);
  if (!Number.isInteger(trials) || trials < 1)
    throw new Error('--trials must be a positive integer');
  const estimateFrom = values('--estimate-from').flatMap((v) => v.split(',').filter(Boolean));
  const fromFiles = estimateFrom.map(
    (p) => JSON.parse(readFileSync(resolve(p), 'utf-8')) as AnyBenchFile,
  );

  const shared: string[] = ['scripts/bench/run.ts', '--provider', 'openrouter'];
  const pass = (n: string): void => {
    const v = value(n);
    if (v !== undefined) shared.push(n, v);
  };
  let spec: MatrixSpec;
  if (mode === 'qa') {
    const qf = JSON.parse(
      readFileSync(resolve(import.meta.dir, 'queries.json'), 'utf-8'),
    ) as QueriesFile;
    const wanted = value('--queries')?.split(',').filter(Boolean);
    const arms = parseArms(value('--arms') ?? QA_DEFAULT_ARMS.join(','));
    const qaFiles = fromFiles.filter((f): f is BenchFile => !('mode' in f));
    spec = {
      mode,
      arms,
      trials,
      items: wanted ? wanted.length : qf.queries.length,
      ...(qaFiles.length ? { qaProfiles: profilesFrom(pooled(qaFiles)) } : {}),
    };
    shared.push('--arms', arms.join(','));
    pass('--queries');
  } else {
    const sf = loadSessionsFile(SESSIONS_PATH);
    const wanted = value('--tasks')?.split(',').filter(Boolean);
    const taskSet = value('--task-set');
    const tasks = selectTasks(sf.tasks, {
      ...(wanted ? { ids: wanted } : {}),
      ...(taskSet !== undefined ? { set: taskSet } : {}),
    });
    const arms = parseMemoryArms(value('--arms'));
    const sFiles = fromFiles.filter((f): f is SessionsBenchFile => 'mode' in f);
    spec = {
      mode,
      arms,
      trials,
      items: tasks.length,
      sessionTasks: taskShapes(tasks),
      ...(sFiles.length ? { sessionProfiles: sessionProfilesFrom(pooled(sFiles)) } : {}),
    };
    shared.push('--mode', 'sessions', '--arms', arms.join(','));
    pass('--task-set');
    pass('--tasks');
  }
  shared.push('--trials', String(trials));
  pass('--max-turns');
  pass('--repo');

  const budgetRaw = value('--budget-usd');
  const budget = budgetRaw === undefined ? null : Number(budgetRaw);
  if (budget !== null && !(Number.isFinite(budget) && budget > 0))
    throw new Error('--budget-usd must be a positive number');
  const plans = planMatrix(models, spec, catalogue, lineup);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const needed = neededUsd(plans, budget);
  if (flag('--dry-run')) {
    const lines = dryRunLines(plans, spec, budget, estimateFrom);
    if (apiKey) {
      try {
        const b = await fetchBalance(apiKey);
        const short = needed === null ? null : creditShortfall(b, needed);
        lines.push(
          '',
          short
            ? `credits: ${short}`
            : `credits: balance $${b.balance.toFixed(2)} covers the $${needed?.toFixed(2)} needed`,
        );
      } catch (err) {
        lines.push(
          '',
          `credits: balance unavailable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      lines.push('', 'credits: not checked (no OPENROUTER_API_KEY); a real run checks them first');
    }
    console.log(lines.join('\n'));
    return;
  }
  if (budget === null) throw new Error('a real run needs --budget-usd');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const bad = plans.filter((p) => p.problem);
  if (bad.length) {
    throw new Error(
      `refusing to start; fix or drop these models first:\n${bad.map((p) => `  ${p.model}: ${p.problem}`).join('\n')}`,
    );
  }
  // Pre-flight: never start a matrix the account can't pay for.
  let balance: Balance;
  try {
    balance = await fetchBalance(apiKey);
  } catch (err) {
    throw new Error(
      `refusing to start: can't read the account balance (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const short = creditShortfall(balance, needed!);
  if (short) throw new Error(`refusing to start: ${short}`);
  log(`credits: balance $${balance.balance.toFixed(2)} covers the $${needed!.toFixed(2)} needed`);
  const repoRoot = resolve(import.meta.dir, '../..');
  const outcomes = await runMatrix(plans, shared, budget, {
    runBench: (args) =>
      new Promise((done) => {
        const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
        child.on('exit', (code) => done(code ?? 1));
      }),
    readResults: (p) =>
      existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as AnyBenchFile) : null,
    writeIndex: () => rebuildIndex(catalogue, date),
    log,
    date,
    exists: existsSync,
    balance: async () => (await fetchBalance(apiKey)).balance,
  });
  const total = outcomes.reduce((s, o) => s + o.spent_usd, 0);
  console.log(
    ['', '| model | status | spent | results |', '|---|---|---:|---|']
      .concat(
        outcomes.map(
          (o) => `| \`${o.model}\` | ${o.status} | $${o.spent_usd.toFixed(4)} | ${o.out ?? '–'} |`,
        ),
      )
      .concat([`| **total** | | **$${total.toFixed(4)}** | |`, ''])
      .concat(matrixSummary(outcomes))
      .join('\n'),
  );
  if (outcomes.some((o) => o.status === 'aborted-credits' || o.status === 'skipped-credits'))
    process.exit(EXIT_INSUFFICIENT_CREDITS);
};

/** Which models finished, which stopped and which never ran. */
export const matrixSummary = (outcomes: readonly MatrixOutcome[]): string[] => {
  const names = (pred: (o: MatrixOutcome) => boolean): string =>
    outcomes
      .filter(pred)
      .map((o) => o.model)
      .join(', ') || 'none';
  const credits = outcomes.some(
    (o) => o.status === 'aborted-credits' || o.status === 'skipped-credits',
  );
  return [
    `finished: ${names((o) => o.status === 'ran')}`,
    ...(outcomes.some((o) => o.status === 'failed')
      ? [`failed: ${names((o) => o.status === 'failed')}`]
      : []),
    ...(credits
      ? [
          `stopped for credits: ${names((o) => o.status === 'aborted-credits' || o.status === 'skipped-credits')} (partial files are marked aborted and excluded from reports and charts)`,
          `not run: ${names((o) => o.status === 'not-run' || o.status === 'skipped-credits')}`,
        ]
      : []),
    ...(outcomes.some((o) => o.status === 'skipped-budget')
      ? [`skipped for budget: ${names((o) => o.status === 'skipped-budget')}`]
      : []),
    credits
      ? 'next: add credits, then rerun the models that did not finish'
      : 'next: bun run bench:chart',
  ];
};

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`bench:matrix: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
