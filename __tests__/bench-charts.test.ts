// SPDX-License-Identifier: Apache-2.0
// The bench charts: byte-identical output for the same data, title/desc text
// whose every number comes from the data, the committed SVGs regenerated from
// the committed results, and sane rendering when an arm or a model is missing.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHARTS_DIR, renderAll } from '../scripts/bench/chart.ts';
import {
  memoryChartData,
  pairedRatio,
  qaChartData,
  renderCrossModelChart,
  renderMemoryChart,
  renderQaChart,
  type MemoryChartData,
} from '../scripts/bench/charts.ts';
import { ciPct, ciPp, pct0, pct1, pp1 } from '../scripts/bench/chart-svg.ts';
import { modelInfo, type IndexModel } from '../scripts/bench/models.ts';
import { aggregate } from '../scripts/bench/report.ts';
import { aggregateSessions, mergeSessionsFiles } from '../scripts/bench/report-sessions.ts';
import { selectQa, selectSessions, type ModelRow } from '../scripts/bench/report-models.ts';
import type {
  BenchFile,
  MemoryArmName,
  SessionRunResult,
  SessionsBenchFile,
} from '../scripts/bench/types.ts';

const RESULTS = resolve(__dirname, '../scripts/bench/results');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(RESULTS, name), 'utf-8')) as T;
const MODEL = 'anthropic/claude-haiku-5.5';

const first = load<SessionsBenchFile>('2026-10-29-sessions-0.3.0.json');
const confirmation = load<SessionsBenchFile>('2026-10-29-sessions-confirmation-0.3.0.json');
const sanity = load<SessionsBenchFile>('2026-10-29-sessions-sanity.json');
const combined = mergeSessionsFiles([first, confirmation]);
const QA_FILES = [
  '2026-10-28-0.2.0-baseline.json',
  '2026-10-28-0.2.0-grep-rig.json',
  '2026-10-28-hybrid-search.json',
  '2026-10-28-hybrid-grep-rig.json',
  '2026-10-29-orientation-map.json',
].map((f) => load<BenchFile>(f));

const titleAndDesc = (svg: string): string => {
  const t = /<title id="[^"]+">([^<]*)<\/title>/.exec(svg)?.[1] ?? '';
  const d = /<desc id="[^"]+">([^<]*)<\/desc>/.exec(svg)?.[1] ?? '';
  return `${t} ${d}`
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
};

// Every numeric token, after removing identifiers that contain digits (model
// ids, run labels, build names): what is left must all come from the data.
const numbersIn = (s: string, identifiers: readonly string[]): string[] => {
  let rest = s;
  for (const id of [...identifiers].sort((a, b) => b.length - a.length))
    rest = rest.split(id).join(' ');
  // Negatives are written with U+2212, so an ASCII hyphen ("session-2") is
  // never a sign.
  return rest.match(/[+−]?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
};

const bare = (s: string): string[] => s.split(/[^0-9.,+−%-]+/).filter((x) => /\d/.test(x));

const wellFormed = (svg: string): void => {
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  expect(svg).toContain('@media (prefers-color-scheme: dark)');
  expect(svg).toMatch(/<title id="[a-z-]+-title">/);
  expect(svg).toMatch(/<desc id="[a-z-]+-desc">/);
  expect(svg).not.toMatch(/NaN|undefined|Infinity|null/);
  // Every element opened is closed (self-closing ones aside).
  const opened = (svg.match(/<(svg|g|text|title|desc|style)[\s>]/g) ?? []).length;
  const closed = (svg.match(/<\/(svg|g|text|title|desc|style)>/g) ?? []).length;
  expect(closed).toBe(opened);
};

describe('determinism', () => {
  test('the same results give byte-identical SVGs', () => {
    const a = renderAll(RESULTS, MODEL);
    const b = renderAll(RESULTS, MODEL);
    expect(Object.keys(a).sort()).toEqual(['cross-model.svg', 'memory.svg', 'qa-tokens.svg']);
    for (const name of Object.keys(a)) expect(a[name]).toBe(b[name]!);
    const d1 = renderMemoryChart(memoryChartData(combined, { iterations: 2000 }), MODEL);
    const d2 = renderMemoryChart(memoryChartData(combined, { iterations: 2000 }), MODEL);
    expect(d1).toBe(d2);
  });

  test('the committed docs/bench charts are regenerated from the committed results', () => {
    for (const [name, svg] of Object.entries(renderAll(RESULTS, MODEL))) {
      expect(readFileSync(join(CHARTS_DIR, name), 'utf-8')).toBe(svg);
      wellFormed(svg);
    }
  });
});

describe('memory chart', () => {
  const d = memoryChartData(combined);
  const svg = renderMemoryChart(d, MODEL);

  test('picks the pre-registered combined run and agrees with the report', () => {
    const picked = selectSessions([sanity, first, confirmation]);
    expect(picked?.combined?.map((c) => c.label)).toEqual([
      'sessions-0.3.0',
      'sessions-confirmation-0.3.0',
    ]);
    const r = aggregateSessions(combined);
    const on = d.deltas.find((x) => x.arm === 'memory-on')!;
    expect(on.delta).toBe(r.paired!.delta);
    expect(on.ci).toEqual(r.paired!.ci);
    expect(on.token_ratio).toBe(r.paired!.token_ratio);
    expect(d.verdict).toEqual(r.verdict);
    // The recorded combined verdict, as committed.
    const md = readFileSync(join(RESULTS, '2026-10-29-sessions-combined-verdict.md'), 'utf-8');
    expect(md).toContain('success delta 40.0 pp, 95% CI 20.0 pp to 60.0 pp');
    expect(pp1(on.delta)).toBe('+40.0 pp');
    expect(ciPp(on.ci)).toBe('+20.0 to +60.0 pp');
    expect(d.verdict!.verdict).toBe('PASS');
  });

  test('every number in the title and desc matches the data', () => {
    const r = aggregateSessions(combined);
    const text = titleAndDesc(svg);
    for (const a of r.arms) {
      const p = d.arms.find((x) => x.arm === a.arm)!;
      expect(p.passed).toBe(a.passed);
      expect(text).toContain(`${a.arm} ${pct0(a.passed / a.runs)} (95% CI ${ciPct(p.ci)})`);
      // The point estimate sits inside its own interval.
      expect(p.ci[0]).toBeLessThanOrEqual(p.rate);
      expect(p.ci[1]).toBeGreaterThanOrEqual(p.rate);
    }
    expect(text).toContain('memory-on 70%');
    expect(text).toContain('memory-off 30%');
    expect(text).toContain('memory-on minus memory-off: +40.0 pp (95% CI +20.0 to +60.0 pp)');
    expect(text).toContain(`at ${pct0(r.paired!.token_ratio!)} of memory-off's median`);
    expect(text).toContain('Verdict: PASS.');
    const allowed = new Set([
      ...d.arms.flatMap((a) => [...bare(pct0(a.rate)), ...bare(ciPct(a.ci))]),
      ...d.arms.flatMap((a) => ciPct(a.ci).replace('%', '').split('–')),
      ...d.deltas.flatMap((x) => [
        ...bare(pp1(x.delta)),
        ...bare(ciPp(x.ci)),
        ...(x.token_ratio === null ? [] : bare(pct0(x.token_ratio))),
      ]),
      String(d.tasks),
      String(d.trials),
      '10,000',
      '2', // "session-2"
      '95%', // "95% CI"
      '+15.0', // the bar
      '110%', // the token cap
    ]);
    const nums = numbersIn(text, [MODEL, ...d.runs]);
    expect(nums.length).toBeGreaterThan(10);
    for (const x of nums) expect(allowed.has(x)).toBe(true);
  });

  const variant = (
    arms: string[],
    extra: (r: SessionRunResult) => SessionRunResult[] = () => [],
  ) => {
    const results = combined.results.flatMap((r) => [
      ...(arms.includes(r.arm) ? [r] : []),
      ...extra(r),
    ]);
    return { ...combined, arms: arms as MemoryArmName[], results };
  };

  test('a missing arm has no row, and nothing else breaks', () => {
    const noOracle = renderMemoryChart(
      memoryChartData(variant(['memory-off', 'memory-on']), { iterations: 500 }),
      MODEL,
    );
    wellFormed(noOracle);
    expect(noOracle).not.toContain('oracle');
    expect(noOracle).toContain('memory-on − memory-off');
    // No memory-off: rates only, no gain panel and no verdict.
    const noOff = memoryChartData(variant(['memory-on', 'oracle']), { iterations: 500 });
    expect(noOff.deltas).toEqual([]);
    expect(noOff.verdict).toBeNull();
    const svgNoOff = renderMemoryChart(noOff, MODEL);
    wellFormed(svgNoOff);
    expect(svgNoOff).not.toContain('Gain over memory-off');
    expect(svgNoOff).not.toContain('Verdict');
  });

  test('an arm added later is charted with its own gain, without code changes', () => {
    const auto = variant(['memory-off', 'memory-on', 'memory-auto', 'oracle'], (r) =>
      r.arm === 'memory-on' ? [{ ...r, arm: 'memory-auto' as MemoryArmName }] : [],
    );
    const ad = memoryChartData(auto, { iterations: 500 });
    expect(ad.arms.map((a) => a.arm)).toEqual(['memory-off', 'memory-on', 'memory-auto', 'oracle']);
    expect(ad.deltas.map((x) => x.arm)).toEqual(['memory-on', 'memory-auto']);
    const s = renderMemoryChart(ad, MODEL);
    wellFormed(s);
    expect(s).toContain('memory-auto − memory-off');
    expect(titleAndDesc(s)).toContain('memory-auto minus memory-off: +40.0 pp');
  });

  test('an aborted run is refused, and left out of the Q&A chart', () => {
    const aborted = { ...combined, aborted: 'insufficient_credits' as const };
    expect(() => memoryChartData(aborted, { iterations: 100 })).toThrow('aborted');
    const picked = selectSessions([first, { ...confirmation, aborted: 'insufficient_credits' }]);
    expect(picked?.label).toBe('sessions-0.3.0');
    expect(picked?.combined).toBeUndefined();
    expect(
      selectQa(QA_FILES.map((f) => ({ ...f, aborted: 'insufficient_credits' as const }))),
    ).toBeNull();
    const qa = qaChartData(
      QA_FILES.map((f) => ({ ...f, aborted: 'insufficient_credits' as const })),
      MODEL,
    );
    expect(qa.stages).toEqual([]);
  });

  test('no sessions run: a "not run yet" chart', () => {
    const s = renderMemoryChart(null, MODEL);
    wellFormed(s);
    expect(s).toContain('not run yet');
    const emptyArms: MemoryChartData = { ...d, arms: [], deltas: [], verdict: null };
    expect(renderMemoryChart(emptyArms, MODEL)).toContain('not run yet');
  });
});

describe('Q&A chart', () => {
  const d = qaChartData(QA_FILES, MODEL);
  const svg = renderQaChart(d);

  test('one stage per rig build, in run order, each arm against its own run baseline', () => {
    expect(d.stages.map((s) => s.name)).toEqual([
      'rig 0.2.0',
      'rig 0.2.0 + hybrid search',
      'rig 0.3.0 + orientation map',
    ]);
    expect(d.stages.map((s) => s.rows.map((r) => r.arm))).toEqual([
      ['rig', 'rig-search', 'grep+rig'],
      ['rig', 'rig-search', 'grep+rig'],
      ['grep+rig', 'grep+rig+map'],
    ]);
    // The overall ratio is the report's paired median ratio, run by run.
    for (const st of d.stages) {
      for (const row of st.rows) {
        const f = QA_FILES.find((x) => x.label === row.run)!;
        const arm = aggregate(f).arms.find((a) => a.arm === row.arm)!;
        expect(row.all).toBe(arm.paired!.median_token_ratio);
        expect(row.queries.lookup + row.queries.natural).toBe(row.queries.all);
      }
    }
    const map = d.stages[2]!.rows[0]!;
    expect(pct1(map.all!)).toBe('133.6%');
  });

  test('every number in the title and desc matches the data', () => {
    const text = titleAndDesc(svg);
    const allowed = new Set<string>(['100%']);
    for (const st of d.stages) {
      for (const r of st.rows) {
        for (const v of [r.all, r.lookup, r.natural]) if (v !== null) allowed.add(pct1(v));
        for (const v of [r.correct, r.runs, r.base_correct, r.base_runs]) allowed.add(String(v));
        expect(text).toContain(
          `${r.arm} ${pct1(r.all!)} overall, lookup ${pct1(r.lookup!)}, natural-language ${pct1(r.natural!)}, ${r.correct}/${r.runs} correct vs grep-only ${r.base_correct}/${r.base_runs}`,
        );
      }
    }
    const nums = numbersIn(text, [MODEL, ...d.stages.map((s) => s.name)]);
    expect(nums.length).toBeGreaterThan(30);
    for (const x of nums) expect(allowed.has(x)).toBe(true);
  });

  test('category ratios: natural cheaper than lookup for grep+rig in every build', () => {
    // What the README caption claims; if a rerun changes it, the caption must too.
    for (const st of d.stages) {
      const g = st.rows.find((r) => r.arm === 'grep+rig')!;
      expect(g.natural!).toBeLessThan(g.lookup!);
      expect(g.all!).toBeGreaterThan(1);
    }
    const f = QA_FILES[4]!;
    expect(pairedRatio(f, 'grep+rig', 'natural').queries).toBe(6);
    expect(pairedRatio(f, 'grep+rig', 'lookup').queries).toBe(10);
  });

  test('a missing arm or model renders without it', () => {
    const noMap = QA_FILES.map((f) => ({
      ...f,
      arms: f.arms.filter((a) => a !== 'grep+rig+map'),
      results: f.results.filter((r) => r.arm !== 'grep+rig+map'),
    }));
    const s = renderQaChart(qaChartData(noMap, MODEL));
    wellFormed(s);
    expect(s).not.toContain('grep+rig+map');
    const none = renderQaChart(qaChartData(QA_FILES, 'openai/gpt-6-luna'));
    wellFormed(none);
    expect(none).toContain('not run yet');
  });
});

describe('cross-model chart', () => {
  const info = (id: string, input: number): IndexModel =>
    modelInfo(
      id,
      {
        id,
        canonical: null,
        tiers: [{ min_prompt_tokens: 0, prompt: input / 1e6, completion: (input * 5) / 1e6 }],
      },
      true,
    );
  const haiku = (): ModelRow => {
    const r = aggregateSessions(selectSessions([first, confirmation])!);
    const q = aggregate(selectQa(QA_FILES)!).arms.find((a) => a.arm === 'grep+rig')!;
    return {
      model: info(MODEL, 0.1),
      memory: {
        runs: ['sessions-0.3.0', 'sessions-confirmation-0.3.0'],
        tasks: 20,
        trials: 3,
        pairs: r.paired!.pairs,
        off_rate: r.paired!.off_rate,
        on_rate: r.paired!.on_rate,
        delta: r.paired!.delta,
        ci: r.paired!.ci,
        token_ratio: r.paired!.token_ratio,
        verdict: r.verdict!.verdict,
        reason: r.verdict!.reason,
      },
      qa: {
        run: 'orientation-map',
        queries: 16,
        trials: 3,
        ratio: q.paired!.median_token_ratio,
        arm_correct: q.correct,
        arm_runs: q.runs,
        base_correct: 48,
        base_runs: 48,
      },
      aborted: { sessions: [], qa: [] },
      resolved_models: [MODEL],
      spent_usd: 0,
    };
  };
  const notRun = (id: string, input: number): ModelRow => ({
    model: info(id, input),
    memory: null,
    qa: null,
    aborted: { sessions: [], qa: [] },
    resolved_models: [],
    spent_usd: 0,
  });

  test('measured and not-run models, grouped by price tier', () => {
    const rows = [haiku(), notRun('openai/gpt-6-luna', 0.1), notRun('google/gemini-4-argon', 2)];
    const svg = renderCrossModelChart(rows, 1);
    wellFormed(svg);
    const text = titleAndDesc(svg);
    expect(text).toContain(
      `${MODEL} (low-cost): memory +40.0 pp (95% CI +20.0 to +60.0 pp), PASS against the bar; Q&A 133.6% of grep-only tokens.`,
    );
    expect(text).toContain('openai/gpt-6-luna (low-cost): memory not run yet; Q&A not run yet.');
    expect(text).toContain('google/gemini-4-argon (frontier): memory not run yet');
    expect(svg).toContain('Low-cost · under $1.00 per M input tokens');
    expect(svg).toContain('Frontier · $1.00 or more per M input tokens');
    expect(svg.indexOf('openai/gpt-6-luna')).toBeLessThan(svg.indexOf('Frontier ·'));
    const allowed = new Set(['2', '95%', '+40.0', '+20.0', '+60.0', '133.6%']);
    const ids = rows.map((r) => r.model.id);
    for (const x of numbersIn(text, ids)) expect(allowed.has(x)).toBe(true);
  });

  test('a model with only one mode run shows the other as not run yet', () => {
    const onlyQa = { ...haiku(), memory: null };
    const svg = renderCrossModelChart([onlyQa], 1);
    wellFormed(svg);
    expect(titleAndDesc(svg)).toContain('memory not run yet; Q&A 133.6%');
  });

  test('no models at all: a "not run yet" state, not an empty plot', () => {
    const svg = renderCrossModelChart([], 1);
    wellFormed(svg);
    expect(svg).toContain('not run yet');
    expect(titleAndDesc(svg)).toContain('No model has results yet.');
  });

  test('a model whose runs were aborted for credits shows "aborted", never a value', () => {
    const row = { ...notRun('openai/gpt-6-luna', 0.1), aborted: { sessions: ['s'], qa: ['q'] } };
    const svg = renderCrossModelChart([haiku(), row], 1);
    wellFormed(svg);
    expect(titleAndDesc(svg)).toContain(
      'openai/gpt-6-luna (low-cost): memory aborted; Q&A aborted.',
    );
    expect(svg).toContain('ran out of credits; its partial results are left out');
    expect(svg).not.toMatch(/gpt-6-luna[^<]*0%/);
  });

  test('an unpriced model gets its own group', () => {
    const svg = renderCrossModelChart(
      [{ ...notRun('acme/x-1', 1), model: modelInfo('acme/x-1', null, false) }],
      1,
    );
    wellFormed(svg);
    expect(svg).toContain('Unpriced');
  });
});
