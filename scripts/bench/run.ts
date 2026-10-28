// SPDX-License-Identifier: Apache-2.0
// Bench orchestrator: index the pinned target with this checkout's rig, run
// every (query, trial, arm) through the agent loop, check each answer against
// queries.json, and write one results file. See README.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAgent } from './agent.ts';
import { makeArm, parseArms } from './arms.ts';
import { RG_BIN, rgAvailable } from './tools-baseline.ts';
import { checkAnswer, validateExpected } from './criteria.ts';
import { judgeAnswer } from './judge.ts';
import { estimatePlan, profilesFrom } from './plan.ts';
import { fetchCatalogue, lookupPricing, perMillion, type ModelPricing } from './pricing.ts';
import {
  DEFAULT_MODELS,
  apiKeyFor,
  makeProvider,
  resolveProviderName,
  type HttpOpts,
} from './providers.ts';
import { gitHead, indexState, prepareIndex, rigVersion } from './target.ts';
import type { BenchFile, QueriesFile, RunResult } from './types.ts';

const USAGE = `usage: bun scripts/bench/run.ts [options]
  --repo <path>            target checkout (default $BENCH_REPO or ~/Development/rig-bench/next-auth)
  --provider <name>        openrouter | anthropic (default $BENCH_PROVIDER, else by which key is set)
  --model <id>             model id (default ${DEFAULT_MODELS.openrouter} / ${DEFAULT_MODELS.anthropic})
  --arms <list>            comma-separated: baseline,rig,rig-search (default all)
  --queries <ids>          comma-separated query ids (default all)
  --trials <n>             trials per (query, arm) (default 3)
  --max-turns <n>          model calls per run before giving up (default 12)
  --judge <model>          also grade answers with an LLM judge (off by default)
  --label <name>           results file label (default: model name)
  --out <path>             results file (default scripts/bench/results/<UTC date>-<label>.json)
  --dry-run                print the plan and cost estimate, call no model
  --estimate-from <file>   dry-run token profile from an earlier results file
  --fresh-index            rebuild the target's .rig index even if current
  --index-only             build (or check) the index and exit, call no model
  --allow-commit-mismatch  run against a target not at the pinned commit
  --queries-file <path>    alternative queries.json`;

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const argValue = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${n} needs a value`);
  return v;
};
const intArg = (n: string, fallback: number): number => {
  const raw = argValue(n);
  if (raw === undefined) return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isInteger(v) || v < 1) throw new Error(`${n} must be a positive integer`);
  return v;
};
const log = (line: string): void => void process.stderr.write(line + '\n');
const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(v < 1 ? 4 : 2)}`);

if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const main = async (): Promise<void> => {
  const repo = resolve(
    argValue('--repo') ??
      process.env.BENCH_REPO ??
      join(homedir(), 'Development/rig-bench/next-auth'),
  );
  const queriesPath = argValue('--queries-file') ?? resolve(import.meta.dir, 'queries.json');
  const qf = JSON.parse(readFileSync(queriesPath, 'utf-8')) as QueriesFile;
  for (const q of qf.queries) validateExpected(q.id, q.expected);
  const wanted = argValue('--queries')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted?.filter((id) => !qf.queries.some((q) => q.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown query id(s): ${unknown.join(', ')}`);
  const queries = wanted ? qf.queries.filter((q) => wanted.includes(q.id)) : qf.queries;

  const arms = parseArms(argValue('--arms'));
  const trials = intArg('--trials', 3);
  const maxTurns = intArg('--max-turns', 12);
  const providerName = resolveProviderName(argValue('--provider'));
  const model = argValue('--model') ?? process.env.BENCH_MODEL ?? DEFAULT_MODELS[providerName];
  const judgeModel = argValue('--judge') ?? null;
  const label = (argValue('--label') ?? model.split('/').pop()!).replace(/[^A-Za-z0-9._-]+/g, '-');
  const dryRun = flag('--dry-run');

  const catalogue = await fetchCatalogue();
  const pricing = lookupPricing(catalogue, model);
  const judgePricing = judgeModel ? lookupPricing(catalogue, judgeModel) : null;

  const head = existsSync(repo) ? gitHead(repo) : null;
  const commitOk = head === qf.target.commit;
  const version = rigVersion();
  const runsPerArm = queries.length * trials;

  if (dryRun) {
    const estimateFrom = argValue('--estimate-from');
    const profiles = estimateFrom
      ? profilesFrom(JSON.parse(readFileSync(estimateFrom, 'utf-8')) as BenchFile)
      : undefined;
    const est = estimatePlan({
      arms,
      runsPerArm,
      pricing,
      ...(profiles ? { profiles } : {}),
      judge: judgeModel !== null,
      judgePricing,
    });
    const priceLine = (p: ModelPricing | null): string =>
      p
        ? `${perMillion(p.tiers[0]!.prompt)} in / ${perMillion(p.tiers[0]!.completion)} out per M tokens` +
          (p.tiers.length > 1
            ? ` (${perMillion(p.tiers.at(-1)!.prompt)} / ${perMillion(p.tiers.at(-1)!.completion)} above ${p.tiers.at(-1)!.min_prompt_tokens.toLocaleString()} prompt tokens)`
            : '')
        : catalogue
          ? 'not in the OpenRouter catalogue'
          : 'catalogue unreachable';
    const lines = [
      '# rig bench — dry run',
      '',
      `provider:  ${providerName}${apiKeyFor(providerName) ? '' : ' (no API key in env)'}`,
      `model:     ${model} — ${priceLine(pricing)}`,
      ...(judgeModel ? [`judge:     ${judgeModel} — ${priceLine(judgePricing)}`] : []),
      `rig:       ${version.version} @ ${version.commit?.slice(0, 7) ?? '?'}${version.dirty ? '+dirty' : ''} (fingerprint ${version.fingerprint})`,
      `target:    ${repo}`,
      `commit:    ${head ?? 'missing'}${commitOk ? ' (pinned)' : ` — expected ${qf.target.commit}`}`,
      `index:     ${existsSync(repo) ? indexState(repo, version.fingerprint) : 'missing'}`,
      ...(arms.includes('baseline')
        ? [
            `ripgrep:   ${rgAvailable() ? RG_BIN : `MISSING (${RG_BIN}); the baseline arm needs it`}`,
          ]
        : []),
      `arms:      ${arms.join(', ')}`,
      `queries:   ${queries.length} (${queries.filter((q) => q.category === 'natural').length} natural-language)`,
      `trials:    ${trials}, max ${maxTurns} model calls per run`,
      `runs:      ${runsPerArm * arms.length} (${runsPerArm} per arm)`,
      '',
      `estimate (${estimateFrom ? `per-arm means from ${estimateFrom}` : 'default per-run token profiles'}):`,
      ...est.arms.map(
        (a) =>
          `  ${a.arm.padEnd(11)} ${a.runs} runs × ~${(a.profile.prompt_tokens / 1000).toFixed(0)}k in + ${(a.profile.completion_tokens / 1000).toFixed(1)}k out ≈ ${usd(a.cost_usd)}`,
      ),
      ...(judgeModel
        ? [`  judge       ${runsPerArm * arms.length} calls ≈ ${usd(est.judge_cost_usd)}`]
        : []),
      `  total       ~${(est.total_tokens / 1e6).toFixed(2)}M tokens ≈ ${usd(est.total_usd)}`,
    ];
    console.log(lines.join('\n'));
    return;
  }

  if (!existsSync(repo)) throw new Error(`target ${repo} does not exist; see README.md "Setup"`);
  if (!commitOk && !flag('--allow-commit-mismatch')) {
    throw new Error(
      `target is at ${head ?? 'unknown'}, expected ${qf.target.commit}. ` +
        `Run \`git -C ${repo} checkout ${qf.target.commit}\` or pass --allow-commit-mismatch.`,
    );
  }
  if (arms.includes('baseline') && !flag('--index-only') && !rgAvailable()) {
    throw new Error(
      `ripgrep not found (${RG_BIN}); the baseline arm needs it. ` +
        'Install it (brew install ripgrep) or point BENCH_RG at the binary.',
    );
  }
  const needsRig = arms.some((a) => a !== 'baseline') || flag('--index-only');
  const indexNow = async () =>
    needsRig ? await prepareIndex(repo, version, { fresh: flag('--fresh-index'), log }) : null;
  if (flag('--index-only')) {
    (await indexNow())?.rig.close();
    return;
  }

  const apiKey = apiKeyFor(providerName);
  if (!apiKey) {
    const env = providerName === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(`${env} is not set (provider ${providerName})`);
  }
  if (catalogue && providerName === 'openrouter' && !pricing) {
    log(`warning: ${model} is not in the OpenRouter catalogue`);
  }
  if (providerName === 'anthropic' && !pricing)
    log(`warning: no list price for ${model}; cost unknown`);

  const http: HttpOpts = { log: (l) => log(`  ${l}`) };
  const provider = makeProvider(providerName, model, apiKey, pricing, http);
  const judge = judgeModel
    ? makeProvider(providerName, judgeModel, apiKey, judgePricing, http)
    : null;

  const index = await indexNow();
  const armImpls = arms.map((a) => makeArm(a, repo, index?.rig ?? null));

  const outPath = (() => {
    const explicit = argValue('--out');
    if (explicit) return resolve(explicit);
    const dir = resolve(import.meta.dir, 'results');
    const stem = `${new Date().toISOString().slice(0, 10)}-${label}`;
    let p = join(dir, `${stem}.json`);
    for (let n = 2; existsSync(p); n++) p = join(dir, `${stem}-${n}.json`);
    return p;
  })();
  mkdirSync(resolve(outPath, '..'), { recursive: true });

  const file: BenchFile = {
    schema: 2,
    label,
    started_at: new Date().toISOString(),
    finished_at: null,
    provider: providerName,
    model,
    judge_model: judgeModel,
    rig: version,
    target: {
      repo,
      commit: head,
      expected_commit: qf.target.commit,
      index: {
        nodes: index?.nodes ?? 0,
        files: index?.files ?? 0,
        rebuilt: index?.rebuilt ?? false,
        elapsed_ms: index?.elapsed_ms ?? 0,
      },
    },
    arms,
    trials,
    max_turns: maxTurns,
    queries,
    results: [],
  };
  // Written after every run, so an interrupted bench keeps what it paid for.
  const save = (): void => writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');

  let spent = 0;
  for (const q of queries) {
    for (let t = 0; t < trials; t++) {
      for (const arm of armImpls) {
        process.stderr.write(`  ${q.id} / ${arm.name} / trial ${t + 1}... `);
        const t0 = Date.now();
        const o = await runAgent(provider, arm, q.ask, { maxTurns, maxTokens: 2048 });
        const r: RunResult = {
          query_id: q.id,
          arm: arm.name,
          trial: t,
          ...o,
          elapsed_ms: Date.now() - t0,
          check: checkAnswer(o.final_text, q.expected),
        };
        if (judge && o.stop === 'answer') r.judge = await judgeAnswer(judge, q, o.final_text);
        file.results.push(r);
        save();
        spent += (r.cost_usd ?? 0) + (r.judge?.cost_usd ?? 0);
        process.stderr.write(
          `${(r.prompt_tokens + r.completion_tokens).toLocaleString()} toks, ${usd(r.cost_usd)}, ` +
            `${r.check.pass ? 'pass' : 'FAIL'}${r.judge ? ` (judge: ${r.judge.verdict})` : ''}` +
            `${r.error ? ` (err: ${r.error.slice(0, 120)})` : r.stop === 'turn_limit' ? ' (turn limit)' : ''}\n`,
        );
      }
    }
  }
  index?.rig.close();
  file.finished_at = new Date().toISOString();
  save();
  console.log(`\nwrote ${file.results.length} runs to ${outPath} (spent ≈ ${usd(spent)})`);
  console.log(`next: bun run bench:report ${outPath}`);
};

main().catch((err: unknown) => {
  console.error(`bench: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
