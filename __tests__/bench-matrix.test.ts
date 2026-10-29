// SPDX-License-Identifier: Apache-2.0
// bench:matrix: per-model estimates, the budget guard, identical flags per
// model, and the results manifest with its by-model view.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  dryRunLines,
  fitsBudget,
  outPathFor,
  planMatrix,
  runMatrix,
  type MatrixSpec,
  type ModelPlan,
} from '../scripts/bench/matrix.ts';
import {
  buildIndex,
  loadResultsDir,
  modelSlug,
  tierFor,
  vendorOf,
  type AnyBenchFile,
} from '../scripts/bench/models.ts';
import { parsePricing, type ModelPricing } from '../scripts/bench/pricing.ts';
import { modelRows, renderByModelMarkdown } from '../scripts/bench/report-models.ts';

const RESULTS = resolve(__dirname, '../scripts/bench/results');

const pricing = (id: string, inPerM: number, outPerM: number): ModelPricing =>
  parsePricing({
    id,
    canonical_slug: `${id}-20261001`,
    supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
    pricing: { prompt: String(inPerM / 1e6), completion: String(outPerM / 1e6) },
  })!;

describe('matrix plan and budget', () => {
  const catalogue = new Map<string, ModelPricing>([
    ['a/cheap', pricing('a/cheap', 0.1, 0.5)],
    ['b/flash', pricing('b/flash', 0.825, 4.125)],
    ['c/big', pricing('c/big', 2, 10)],
    [
      'd/no-tools',
      parsePricing({
        id: 'd/no-tools',
        supported_parameters: ['max_tokens'],
        pricing: { prompt: '0.0000001', completion: '0.0000001' },
      })!,
    ],
  ]);
  const spec: MatrixSpec = {
    mode: 'qa',
    arms: ['baseline', 'grep+rig'],
    trials: 3,
    items: 16,
    qaProfiles: {
      baseline: { prompt_tokens: 18_000, completion_tokens: 600, model_calls: 4 },
      'grep+rig': { prompt_tokens: 22_000, completion_tokens: 700, model_calls: 4 },
    },
  };

  test('tiers by input price, slugs, vendors', () => {
    expect(tierFor(0.1e-6)).toBe('low-cost');
    expect(tierFor(0.825e-6)).toBe('low-cost');
    expect(tierFor(1e-6)).toBe('frontier');
    expect(tierFor(null)).toBeNull();
    expect(modelSlug('openai/gpt-6.1-sol')).toBe('openai-gpt-6.1-sol');
    expect(vendorOf('qwen/qwen3.8-flash')).toBe('qwen');
  });

  test('estimates from measured profiles, with a max_tokens ceiling, and flags models that cannot run', () => {
    const plans = planMatrix(['a/cheap', 'c/big', 'd/no-tools', 'e/missing'], spec, catalogue);
    const [cheap, big, noTools, missing] = plans;
    // 48 runs per arm: (18,000 + 22,000) × 48 prompt, (600 + 700) × 48 completion.
    expect(cheap!.estimate_usd).toBeCloseTo(1_920_000 * 0.1e-6 + 62_400 * 0.5e-6, 9);
    expect(big!.estimate_usd).toBeCloseTo(cheap!.estimate_usd! * 20, 9);
    expect(cheap!.ceiling_usd!).toBeGreaterThan(cheap!.estimate_usd!);
    expect(cheap!.label).toBe('qa-a-cheap');
    expect(cheap!.problem).toBeNull();
    expect(noTools!.problem).toContain('no tool calling');
    expect(missing!.problem).toContain('not in the OpenRouter catalogue');
    expect(missing!.estimate_usd).toBeNull();
    const text = dryRunLines(plans.slice(0, 2), spec, 0.5, ['x.json']).join('\n');
    expect(text).toContain('| **total** (2 models)');
    expect(text).toContain('budget $0.50: at the estimates, 1/2 models run before the guard stops');
  });

  test('the guard: spent so far plus the next estimate must fit', () => {
    expect(fitsBudget(0.5, 0.5, 1)).toBe(true);
    expect(fitsBudget(0.5, 0.51, 1)).toBe(false);
    expect(fitsBudget(0, null, 100)).toBe(false);
  });

  test('runs each model with identical flags, counts actual spend, stops before the budget', async () => {
    const plan = (model: string, est: number): ModelPlan => ({
      ...planMatrix([model], spec, catalogue)[0]!,
      estimate_usd: est,
    });
    const plans = [plan('a/cheap', 0.4), plan('b/flash', 0.4), plan('c/big', 0.4)];
    const spends: Record<string, number> = { 'a/cheap': 0.45, 'b/flash': 0.5 };
    const seen: string[][] = [];
    let indexed = 0;
    const shared = [
      'scripts/bench/run.ts',
      '--provider',
      'openrouter',
      '--arms',
      'baseline,grep+rig',
    ];
    const out = await runMatrix(plans, shared, 1.2, {
      runBench: async (args) => {
        seen.push(args);
        return 0;
      },
      readResults: (path) => {
        const model = Object.keys(spends).find((m) => path.includes(modelSlug(m)));
        return {
          mode: 'sessions',
          results: [{ s1: null, s2: { cost_usd: spends[model!] ?? 0 } }],
        } as unknown as AnyBenchFile;
      },
      writeIndex: () => void indexed++,
      log: () => {},
      date: '2026-10-29',
      exists: () => false,
    });
    expect(out.map((o) => [o.model, o.status])).toEqual([
      ['a/cheap', 'ran'],
      ['b/flash', 'ran'],
      ['c/big', 'skipped-budget'],
    ]);
    expect(out[0]!.spent_usd).toBe(0.45);
    expect(indexed).toBe(2);
    // Identical except model, label, results path and the remaining-budget cap.
    const strip = (a: string[]) => {
      const keep: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (['--model', '--label', '--out', '--max-spend-usd'].includes(a[i]!)) i++;
        else keep.push(a[i]!);
      }
      return keep;
    };
    expect(strip(seen[0]!)).toEqual(shared);
    expect(strip(seen[1]!)).toEqual(shared);
    const val = (a: string[], f: string) => a[a.indexOf(f) + 1];
    expect(val(seen[0]!, '--label')).toBe('qa-a-cheap');
    expect(val(seen[0]!, '--out')).toEndWith('/2026-10-29-qa-a-cheap.json');
    expect(val(seen[0]!, '--max-spend-usd')).toBe('1.200000');
    expect(val(seen[1]!, '--max-spend-usd')).toBe('0.750000');
  });

  test('a run that spends the whole budget stops the matrix', async () => {
    const plans = ['a/cheap', 'b/flash'].map((m) => ({
      ...planMatrix([m], spec, catalogue)[0]!,
      estimate_usd: 0.1,
    }));
    const out = await runMatrix(plans, [], 0.5, {
      runBench: async () => 1,
      readResults: () =>
        ({
          mode: 'sessions',
          results: [{ s1: null, s2: { cost_usd: 0.5 } }],
        }) as unknown as AnyBenchFile,
      writeIndex: () => {},
      log: () => {},
      date: '2026-10-29',
      exists: () => false,
    });
    expect(out.map((o) => o.status)).toEqual(['failed', 'skipped-budget']);
  });

  test('results paths never overwrite an earlier run', () => {
    const taken = new Set(['/r/2026-10-29-qa-x.json', '/r/2026-10-29-qa-x-2.json']);
    expect(outPathFor('qa-x', '2026-10-29', (p) => taken.has(p), '/r')).toBe(
      '/r/2026-10-29-qa-x-3.json',
    );
  });
});

describe('results manifest and by-model view', () => {
  const files = loadResultsDir(RESULTS);
  const lineup = ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'];
  const catalogue = new Map([
    ['anthropic/claude-haiku-5.5', pricing('anthropic/claude-haiku-5.5', 0.1, 0.5)],
    ['openai/gpt-6-luna', pricing('openai/gpt-6-luna', 0.1, 0.5)],
  ]);

  test('one entry per results file, with mode, vendor and tier; deterministic', () => {
    const a = buildIndex({ files, catalogue, previous: null, lineup, asOf: '2026-10-29' });
    const b = buildIndex({ files, catalogue, previous: null, lineup, asOf: '2026-10-29' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.runs.map((r) => r.file)).toEqual(files.map((f) => f.file));
    const sessions = a.runs.filter((r) => r.mode === 'sessions');
    expect(sessions.map((r) => r.label)).toEqual([
      'sessions-0.3.0',
      'sessions-confirmation-0.3.0',
      'sessions-sanity',
    ]);
    for (const r of a.runs) {
      expect(r.vendor).toBe('anthropic');
      expect(r.tier).toBe('low-cost');
      expect(r.resolved_models).toEqual(['anthropic/claude-haiku-5.5']);
    }
    expect(a.models.map((m) => m.id)).toEqual(lineup);
    expect(a.models[1]!.in_lineup).toBe(true);
    expect(a.fairness.join(' ')).toContain('provider defaults');
  });

  test('offline, a rebuild keeps the previous prices', () => {
    const prev = buildIndex({ files, catalogue, previous: null, lineup, asOf: '2026-10-29' });
    const offline = buildIndex({ files, catalogue: null, previous: prev, lineup, asOf: null });
    expect(offline.models).toEqual(prev.models);
    expect(offline.prices_as_of).toBe('2026-10-29');
  });

  test('the committed index.json lists every committed results file', () => {
    const committed = JSON.parse(readFileSync(join(RESULTS, 'index.json'), 'utf-8')) as {
      runs: { file: string }[];
    };
    expect(committed.runs.map((r) => r.file)).toEqual(files.map((f) => f.file));
  });

  test('by-model rows: the measured model has both modes, the rest are not run yet', () => {
    const index = buildIndex({ files, catalogue, previous: null, lineup, asOf: '2026-10-29' });
    const byFile = new Map(files.map((f) => [f.file, f.data]));
    const rows = modelRows(index, (r) => byFile.get(r.file)!);
    const [haiku, luna] = rows;
    expect(haiku!.memory!.runs).toEqual(['sessions-0.3.0', 'sessions-confirmation-0.3.0']);
    expect(haiku!.memory!.verdict).toBe('PASS');
    expect(haiku!.qa!.run).toBe('orientation-map');
    expect(luna!.memory).toBeNull();
    expect(luna!.qa).toBeNull();
    const md = renderByModelMarkdown(index, rows);
    expect(md).toContain(
      '| `anthropic/claude-haiku-5.5` | low-cost | 0.10 · 0.50 | 30% | 70% | +40.0 pp (+20.0 pp to +60.0 pp) | 94% | PASS | 20 × 3 |',
    );
    expect(md).toContain('| `openai/gpt-6-luna` | low-cost | 0.10 · 0.50 | not run yet |');
    expect(md).toContain('| 133.6% | 48/48 | 48/48 | 16 × 3 | `orientation-map` |');
  });
});
