// SPDX-License-Identifier: Apache-2.0
// The bench charts, as pure functions from results to SVG text:
//   memory       session-2 success per arm with 95% CIs, and each memory
//                arm's paired gain over memory-off against the +15 pp bar
//   qa-tokens    single-shot tokens relative to grep-only, by rig version
//                and arm, for all queries and per category
//   cross-model  memory gain and Q&A token ratio per model, by price tier
// Arms and models are read from the data, so an arm or model added later
// shows up without changes here; one that is missing simply has no row, and a
// lineup model with no results gets a "not run yet" row. bench:chart writes
// them to docs/bench/; never edit the SVGs by hand.
import { median } from './report.ts';
import {
  bootstrapPaired,
  bootstrapRate,
  pairArms,
  verdictFor,
  type VerdictResult,
} from './report-sessions.ts';
import { QA_ARM, QA_BASE, type ModelRow } from './report-models.ts';
import { BAR_DELTA, BAR_TOKEN_RATIO } from './sessions.ts';
import {
  ciPct,
  ciPp,
  dot,
  hit,
  line,
  niceDomain,
  pct0,
  pct1,
  pp1,
  ppTick,
  scale,
  svgDoc,
  text,
  whisker,
  wrap,
  xAxis,
  type Series,
} from './chart-svg.ts';
import type { BenchFile, RunResult, SessionsBenchFile } from './types.ts';

const W = 760;
const PAD = 24;

// Arms that frame the result rather than test memory: drawn in the muted
// tone, never compared against the bar.
export const REFERENCE_ARMS: Readonly<Record<string, string>> = {
  oracle: 'upper bound',
  'grep-only': 'code only',
};
const BASE_ARM = 'memory-off';

// ------------------------------------------------------------------ memory

export interface MemoryArmPoint {
  arm: string;
  rate: number;
  ci: [number, number];
  passed: number;
  runs: number;
  reference: boolean;
}

export interface MemoryDeltaPoint {
  arm: string;
  delta: number;
  ci: [number, number];
  pairs: number;
  token_ratio: number | null;
}

export interface MemoryChartData {
  model: string;
  runs: string[];
  tasks: number;
  trials: number;
  iterations: number;
  seed: number;
  arms: MemoryArmPoint[];
  // Each non-reference arm other than memory-off, minus memory-off.
  deltas: MemoryDeltaPoint[];
  // The pre-registered verdict: memory-on minus memory-off only.
  verdict: VerdictResult | null;
}

export const memoryChartData = (
  file: SessionsBenchFile,
  opts: { iterations?: number; seed?: number } = {},
): MemoryChartData => {
  const boot = {
    ...(opts.iterations !== undefined ? { iterations: opts.iterations } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
  const arms = file.arms.flatMap((arm): MemoryArmPoint[] => {
    const rs = file.results.filter((r) => r.arm === arm);
    const b = bootstrapRate(
      rs.map((r) => ({ task: r.task_id, pass: r.check.pass ? 1 : 0 })),
      boot,
    );
    return b
      ? [
          {
            arm,
            rate: b.rate,
            ci: b.ci,
            passed: rs.filter((r) => r.check.pass).length,
            runs: rs.length,
            reference: arm in REFERENCE_ARMS,
          },
        ]
      : [];
  });
  const deltas = file.arms
    .filter((a) => a !== BASE_ARM && !(a in REFERENCE_ARMS) && file.arms.includes(BASE_ARM))
    .flatMap((arm): MemoryDeltaPoint[] => {
      const d = bootstrapPaired(pairArms(file.results, arm, BASE_ARM), boot);
      return d
        ? [{ arm, delta: d.delta, ci: d.ci, pairs: d.pairs, token_ratio: d.token_ratio }]
        : [];
    });
  const on = file.arms.includes('memory-on') && file.arms.includes(BASE_ARM);
  const paired = on ? bootstrapPaired(pairArms(file.results, 'memory-on', BASE_ARM), boot) : null;
  return {
    model: file.model,
    runs: file.combined ? file.combined.map((c) => c.label) : [file.label],
    tasks: new Set(file.results.map((r) => r.task_id)).size,
    trials: file.trials,
    iterations: opts.iterations ?? 10_000,
    seed: opts.seed ?? 20261029,
    arms,
    deltas,
    verdict: paired ? verdictFor(paired) : null,
  };
};

const armLabel = (arm: string): string =>
  REFERENCE_ARMS[arm] ? `${arm} (${REFERENCE_ARMS[arm]})` : arm;

const memoryDesc = (d: MemoryChartData): string => {
  const parts = [
    `Session-2 success over ${d.tasks} task pairs × ${d.trials} trials (runs ${d.runs.join(' + ')}), with 95% CIs from a ${d.iterations.toLocaleString('en-US')}-draw two-level bootstrap.`,
    d.arms.map((a) => `${a.arm} ${pct0(a.rate)} (95% CI ${ciPct(a.ci)})`).join('; ') + '.',
    ...d.deltas.map(
      (x) =>
        `${x.arm} minus ${BASE_ARM}: ${pp1(x.delta)} (95% CI ${ciPp(x.ci)})` +
        (x.token_ratio === null
          ? '.'
          : `, at ${pct0(x.token_ratio)} of ${BASE_ARM}'s median total tokens.`),
    ),
    `Pre-registered bar: memory-on at least ${pp1(BAR_DELTA)} over ${BASE_ARM} across the whole CI, at no more than ${pct0(BAR_TOKEN_RATIO)} of its median tokens.`,
  ];
  if (d.verdict) parts.push(`Verdict: ${d.verdict.verdict}.`);
  return parts.join(' ');
};

const emptyChart = (id: string, title: string, message: string, note: string): string =>
  svgDoc({
    width: W,
    height: 120,
    id,
    title,
    desc: `${title}: ${message}`,
    body: [
      text(PAD, 32, title, { cls: 'title' }),
      text(PAD, 70, message, { cls: 'empty' }),
      text(PAD, 96, note, { cls: 'note' }),
    ].join('\n'),
  });

export const renderMemoryChart = (d: MemoryChartData | null, model: string): string => {
  const title = `Multi-session memory: session-2 success, ${model}`;
  if (!d || d.arms.length === 0) {
    return emptyChart(
      'memory',
      title,
      'not run yet',
      'bun run bench:run --mode sessions, then bun run bench:chart',
    );
  }
  const labelX = PAD;
  const x0 = 210;
  const x1 = 600;
  const valX = 616;
  const rowH = 30;
  const body: string[] = [];
  let y = 32;
  body.push(text(PAD, y, title, { cls: 'title' }));
  y += 20;
  body.push(
    text(
      PAD,
      y,
      `${d.tasks} task pairs × ${d.trials} trials · 95% CI: two-level bootstrap (tasks, then trials), ${d.iterations.toLocaleString('en-US')} draws`,
      { cls: 'sub' },
    ),
  );

  // Panel 1: success by arm.
  y += 30;
  body.push(text(PAD, y, 'Session 2 passed its check', { cls: 'head' }));
  body.push(text(valX, y, 'rate (95% CI)', { cls: 'note' }));
  const s1 = scale(0, 1, x0, x1, 0.2);
  const top1 = y + 10;
  const bottom1 = top1 + d.arms.length * rowH;
  body.push(xAxis(s1, top1, bottom1, pct0));
  d.arms.forEach((a, i) => {
    const cy = top1 + rowH * i + rowH / 2;
    const s: Series = a.reference ? 'muted' : 's1';
    body.push(text(labelX, cy, armLabel(a.arm), { cls: 'lab', baseline: 'middle' }));
    body.push(whisker(s1(a.ci[0]), s1(a.ci[1]), cy, s));
    body.push(dot(s1(a.rate), cy, s));
    body.push(
      text(valX, cy, `${pct0(a.rate)} (${ciPct(a.ci)})`, { cls: 'val', baseline: 'middle' }),
    );
    body.push(
      hit(
        labelX,
        cy - rowH / 2,
        W - 2 * PAD,
        rowH,
        `${a.arm}: ${a.passed}/${a.runs} passed, ${pct0(a.rate)}, 95% CI ${ciPct(a.ci)}`,
      ),
    );
  });
  y = bottom1 + 15;

  // Panel 2: each memory arm's paired gain over memory-off, against the bar.
  if (d.deltas.length) {
    y += 34;
    body.push(text(PAD, y, `Gain over ${BASE_ARM}, same (task, trial) pairs`, { cls: 'head' }));
    body.push(text(valX, y, 'gain (95% CI)', { cls: 'note' }));
    const [lo, hi] = niceDomain(
      d.deltas.flatMap((x) => [x.ci[0], x.ci[1]]),
      -0.2,
      0.8,
      0.2,
    );
    const s2 = scale(lo, hi, x0, x1, 0.2);
    const top2 = y + 26;
    const bottom2 = top2 + d.deltas.length * rowH;
    body.push(xAxis(s2, top2, bottom2, ppTick));
    body.push(line(s2(0), top2, s2(0), bottom2, 'axis'));
    body.push(line(s2(BAR_DELTA), top2 - 6, s2(BAR_DELTA), bottom2, 'ref'));
    body.push(
      text(s2(BAR_DELTA) + 4, top2 - 8, `pre-registered bar ${pp1(BAR_DELTA)}`, { cls: 'note' }),
    );
    d.deltas.forEach((x, i) => {
      const cy = top2 + rowH * i + rowH / 2;
      body.push(text(labelX, cy, `${x.arm} − ${BASE_ARM}`, { cls: 'lab', baseline: 'middle' }));
      body.push(whisker(s2(x.ci[0]), s2(x.ci[1]), cy, 's1'));
      body.push(dot(s2(x.delta), cy, 's1'));
      body.push(
        text(valX, cy, `${pp1(x.delta).replace(' pp', '')} (${ciPp(x.ci).replace(' pp', '')})`, {
          cls: 'val',
          baseline: 'middle',
        }),
      );
      body.push(
        hit(
          labelX,
          cy - rowH / 2,
          W - 2 * PAD,
          rowH,
          `${x.arm} − ${BASE_ARM}: ${pp1(x.delta)}, 95% CI ${ciPp(x.ci)}, ${x.pairs} pairs`,
        ),
      );
    });
    y = bottom2 + 15;
  }

  // The verdict and the token clause, in words.
  if (d.verdict) {
    const on = d.deltas.find((x) => x.arm === 'memory-on');
    const sentence =
      `Pre-registered verdict (memory-on vs ${BASE_ARM}): ${d.verdict.verdict}. ` +
      (on
        ? `The whole CI must clear ${pp1(BAR_DELTA)} and tokens stay within ${pct0(BAR_TOKEN_RATIO)} of ${BASE_ARM}'s median; memory-on used ${on.token_ratio === null ? 'an unknown share' : pct0(on.token_ratio)}.`
        : '');
    y += 30;
    for (const l of wrap(sentence, 112)) {
      body.push(text(PAD, y, l, { cls: 'sub' }));
      y += 17;
    }
    y -= 17;
  }
  if (d.arms.some((a) => a.reference)) {
    y += 20;
    body.push(
      text(
        PAD,
        y,
        'Grey: reference arms, outside the verdict. oracle is told session 1’s facts; it bounds what memory could recover.',
        { cls: 'note' },
      ),
    );
  }
  y += 16;
  body.push(text(PAD, y, `Runs: ${d.runs.join(' + ')}`, { cls: 'note' }));
  return svgDoc({
    width: W,
    height: y + 18,
    id: 'memory',
    title,
    desc: memoryDesc(d),
    body: body.join('\n'),
  });
};

// ------------------------------------------------------------------ Q&A

// Display names for the rig builds the single-shot runs measured, by source
// fingerprint; an unknown build is named by its version and fingerprint.
export const STAGE_NAMES: Readonly<Record<string, string>> = {
  '5dd01413ae17d174': 'rig 0.2.0',
  f0e6da8652a16429: 'rig 0.2.0 + hybrid search',
  '14b6ca5108774da6': 'rig 0.3.0 + orientation map',
};

export type Category = 'lookup' | 'natural';

const tokensOf = (r: RunResult): number => r.prompt_tokens + r.completion_tokens;

/**
 * Median over queries of (arm median tokens ÷ baseline median tokens), the
 * report's paired ratio, optionally over one query category only.
 */
export const pairedRatio = (
  file: BenchFile,
  arm: string,
  category?: Category,
): { ratio: number | null; queries: number } => {
  const cat = new Map(file.queries.map((q) => [q.id, q.category]));
  const ids = [...new Set(file.results.map((r) => r.query_id))].filter(
    (id) => category === undefined || cat.get(id) === category,
  );
  const ratios: number[] = [];
  let queries = 0;
  for (const id of ids) {
    const a = file.results.filter((r) => r.arm === arm && r.query_id === id);
    const b = file.results.filter((r) => r.arm === QA_BASE && r.query_id === id);
    if (a.length === 0 || b.length === 0) continue;
    queries++;
    const bt = median(b.map(tokensOf));
    if (bt > 0) ratios.push(median(a.map(tokensOf)) / bt);
  }
  return { ratio: ratios.length ? median(ratios) : null, queries };
};

export interface QaPoint {
  arm: string;
  run: string;
  all: number | null;
  lookup: number | null;
  natural: number | null;
  queries: { all: number; lookup: number; natural: number };
  correct: number;
  runs: number;
  base_correct: number;
  base_runs: number;
}

export interface QaStage {
  name: string;
  fingerprint: string;
  rows: QaPoint[];
}

export interface QaChartData {
  model: string;
  trials: number[];
  stages: QaStage[];
}

/**
 * One stage per rig build (source fingerprint), in the order the builds were
 * first run; in each, one row per arm compared with baseline, from the newest
 * run of that build that has the arm. Arms appear in the order runs list them.
 */
export const qaChartData = (files: readonly BenchFile[], model: string): QaChartData => {
  const own = [...files]
    .filter((f) => f.model === model && f.arms.includes(QA_BASE))
    .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  const prints = [...new Set(own.map((f) => f.rig.fingerprint))];
  const stages = prints.map((fp): QaStage => {
    const runs = own.filter((f) => f.rig.fingerprint === fp);
    const arms = [...new Set(runs.flatMap((f) => f.arms))].filter((a) => a !== QA_BASE);
    const rows = arms.map((arm): QaPoint => {
      const f = runs.filter((r) => r.arms.includes(arm)).at(-1)!;
      const count = (pred: (r: RunResult) => boolean) => f.results.filter(pred).length;
      const all = pairedRatio(f, arm);
      const lookup = pairedRatio(f, arm, 'lookup');
      const natural = pairedRatio(f, arm, 'natural');
      return {
        arm,
        run: f.label,
        all: all.ratio,
        lookup: lookup.ratio,
        natural: natural.ratio,
        queries: { all: all.queries, lookup: lookup.queries, natural: natural.queries },
        correct: count((r) => r.arm === arm && r.check.pass),
        runs: count((r) => r.arm === arm),
        base_correct: count((r) => r.arm === QA_BASE && r.check.pass),
        base_runs: count((r) => r.arm === QA_BASE),
      };
    });
    const v = runs[0]!.rig;
    return {
      name: STAGE_NAMES[fp] ?? `rig ${v.version} (${fp.slice(0, 7)})`,
      fingerprint: fp,
      rows,
    };
  });
  return { model, trials: [...new Set(own.map((f) => f.trials))].sort(), stages };
};

const QA_SERIES: {
  key: 'all' | Category;
  series: Series;
  label: (q: QaPoint['queries']) => string;
  dy: number;
}[] = [
  { key: 'lookup', series: 's2', label: (q) => `lookup questions (${q.lookup})`, dy: -7 },
  {
    key: 'natural',
    series: 's3',
    label: (q) => `natural-language questions (${q.natural})`,
    dy: 7,
  },
  { key: 'all', series: 's1', label: (q) => `all ${q.all} questions`, dy: 0 },
];

const qaDesc = (d: QaChartData): string =>
  [
    `Single-shot Q&A, ${d.model}: tokens per question relative to grep-only (median over questions of the arm's median tokens divided by grep-only's), by rig build and arm. 100% means the same cost as grep-only; above means more tokens.`,
    ...d.stages.map(
      (s) =>
        `${s.name}: ` +
        s.rows
          .map(
            (r) =>
              `${r.arm} ${r.all === null ? 'n/a' : pct1(r.all)} overall, lookup ${r.lookup === null ? 'n/a' : pct1(r.lookup)}, natural-language ${r.natural === null ? 'n/a' : pct1(r.natural)}, ${r.correct}/${r.runs} correct vs grep-only ${r.base_correct}/${r.base_runs}`,
          )
          .join('; ') +
        '.',
    ),
  ].join(' ');

export const renderQaChart = (d: QaChartData): string => {
  const title = `Single-shot Q&A: tokens relative to grep-only, ${d.model}`;
  const points = d.stages.flatMap((s) => s.rows);
  if (points.length === 0) {
    return emptyChart(
      'qa-tokens',
      title,
      'not run yet',
      'bun run bench:run, then bun run bench:chart',
    );
  }
  const x0 = 200;
  const x1 = 560;
  const valX = 580;
  const rowH = 30;
  const stageH = 26;
  const body: string[] = [];
  let y = 32;
  body.push(text(PAD, y, title, { cls: 'title' }));
  y += 20;
  body.push(
    text(
      PAD,
      y,
      'Per question: arm median tokens ÷ grep-only median tokens; the dot is the median over questions. Left of 100% is cheaper.',
      { cls: 'sub' },
    ),
  );
  // Legend: every series, with its dot as the key.
  y += 26;
  const q = points[0]!.queries;
  let lx = PAD;
  for (const s of [QA_SERIES[2]!, QA_SERIES[0]!, QA_SERIES[1]!]) {
    body.push(dot(lx + 5, y - 4, s.series));
    const label = s.label(q);
    body.push(text(lx + 15, y, label, { cls: 'lab' }));
    lx += 15 + label.length * 6.4 + 22;
  }

  const values = points.flatMap((p) => [p.all, p.lookup, p.natural]).filter((v) => v !== null);
  const [, hi] = niceDomain(values as number[], 0, 2, 0.5);
  const s = scale(0, hi, x0, x1, 0.5);
  y += 30;
  const top = y;
  const height = d.stages.length * stageH + points.length * rowH;
  body.push(text(valX, top - 6, 'all · correct (arm, grep)', { cls: 'note' }));
  body.push(xAxis(s, top, top + height, pct0));
  body.push(line(s(1), top - 4, s(1), top + height, 'ref'));
  body.push(text(s(1) + 4, top - 6, 'grep-only = 100%', { cls: 'note' }));
  for (const st of d.stages) {
    y += stageH;
    body.push(text(PAD, y - 8, st.name, { cls: 'head' }));
    for (const r of st.rows) {
      const cy = y + rowH / 2;
      body.push(text(PAD + 12, cy, r.arm, { cls: 'lab', baseline: 'middle' }));
      for (const ser of QA_SERIES) {
        const v = r[ser.key];
        if (v !== null) body.push(dot(s(v), cy + ser.dy, ser.series, 4.5));
      }
      body.push(
        text(
          valX,
          cy,
          `${r.all === null ? '–' : pct1(r.all)} · ${r.correct}/${r.runs}, ${r.base_correct}/${r.base_runs}`,
          { cls: 'val', baseline: 'middle' },
        ),
      );
      body.push(
        hit(
          PAD,
          y,
          W - 2 * PAD,
          rowH,
          `${st.name}, ${r.arm} (run ${r.run}): all ${r.all === null ? 'n/a' : pct1(r.all)}, lookup ${r.lookup === null ? 'n/a' : pct1(r.lookup)}, natural-language ${r.natural === null ? 'n/a' : pct1(r.natural)}; correct ${r.correct}/${r.runs} vs grep-only ${r.base_correct}/${r.base_runs}`,
        ),
      );
      y += rowH;
    }
  }
  y += 34;
  body.push(
    text(
      PAD,
      y,
      `${d.trials.join(', ')} trials per question and arm; each build measured against its own grep-only arm in the same run.`,
      { cls: 'note' },
    ),
  );
  return svgDoc({
    width: W,
    height: y + 18,
    id: 'qa-tokens',
    title,
    desc: qaDesc(d),
    body: body.join('\n'),
  });
};

// ------------------------------------------------------------------ cross-model

const TIER_ORDER = ['low-cost', 'frontier', null] as const;

const tierHeading = (tier: string | null, threshold: number): string =>
  tier === 'low-cost'
    ? `Low-cost · under $${threshold.toFixed(2)} per M input tokens`
    : tier === 'frontier'
      ? `Frontier · $${threshold.toFixed(2)} or more per M input tokens`
      : 'Unpriced';

const crossDesc = (rows: readonly ModelRow[]): string => {
  const ran = rows.filter((r) => r.memory || r.qa);
  const parts = [
    `Per model: session-2 memory gain (memory-on minus memory-off, 95% CI) and single-shot ${QA_ARM} tokens relative to grep-only.`,
    ...rows.map((r) => {
      const m = r.memory
        ? `memory ${pp1(r.memory.delta)} (95% CI ${ciPp(r.memory.ci)}), ${r.memory.verdict} against the bar`
        : 'memory not run yet';
      const q = r.qa
        ? `Q&A ${r.qa.ratio === null ? 'n/a' : pct1(r.qa.ratio)} of grep-only tokens`
        : 'Q&A not run yet';
      return `${r.model.id} (${r.model.tier ?? 'unpriced'}): ${m}; ${q}.`;
    }),
  ];
  if (ran.length === 0) parts.push('No model has results yet.');
  return parts.join(' ');
};

export const renderCrossModelChart = (rows: readonly ModelRow[], threshold: number): string => {
  const title = 'Across models: memory gain and Q&A token cost';
  const label0 = PAD;
  const m0 = 230;
  const m1 = 420;
  const mVal = 428;
  const q0 = 528;
  const q1 = 664;
  const qVal = 672;
  const rowH = 28;
  const tierH = 28;
  const body: string[] = [];
  let y = 32;
  body.push(text(PAD, y, title, { cls: 'title' }));
  y += 20;
  body.push(
    text(
      PAD,
      y,
      'Same prompts, tools, arms, trials and turn limit for every model, via OpenRouter, at each provider’s defaults.',
      { cls: 'sub' },
    ),
  );
  if (rows.length === 0) {
    body.push(
      text(PAD, y + 40, 'not run yet: no models in the lineup or the results', { cls: 'empty' }),
    );
    return svgDoc({
      width: W,
      height: y + 70,
      id: 'cross-model',
      title,
      desc: crossDesc(rows),
      body: body.join('\n'),
    });
  }
  y += 32;
  body.push(text(m0, y, 'Memory gain, pp (95% CI)', { cls: 'head' }));
  body.push(text(q0, y, `${QA_ARM} ÷ grep-only tokens`, { cls: 'head' }));
  const mVals = rows.flatMap((r) => (r.memory ? [r.memory.ci[0], r.memory.ci[1]] : []));
  const [mlo, mhi] = niceDomain(mVals, -0.2, 0.8, 0.2);
  const sm = scale(mlo, mhi, m0, m1, 0.2);
  const qVals = rows.flatMap((r) => (r.qa?.ratio != null ? [r.qa.ratio] : []));
  const [, qhi] = niceDomain(qVals, 0, 2, 1);
  const sq = scale(0, qhi, q0, q1, 1);
  y += 26;
  const top = y;
  const groups = TIER_ORDER.map((t) => ({
    tier: t,
    rows: rows.filter((r) => r.model.tier === t),
  })).filter((g) => g.rows.length);
  const height = groups.length * tierH + rows.length * rowH;
  body.push(xAxis(sm, top, top + height, ppTick));
  body.push(line(sm(0), top, sm(0), top + height, 'axis'));
  body.push(line(sm(BAR_DELTA), top - 4, sm(BAR_DELTA), top + height, 'ref'));
  body.push(text(sm(BAR_DELTA) + 4, top - 6, `bar ${pp1(BAR_DELTA)}`, { cls: 'note' }));
  body.push(xAxis(sq, top, top + height, pct0));
  body.push(line(sq(1), top - 4, sq(1), top + height, 'ref'));
  body.push(text(sq(1) + 4, top - 6, 'grep-only', { cls: 'note' }));
  for (const g of groups) {
    y += tierH;
    body.push(text(PAD, y - 9, tierHeading(g.tier, threshold), { cls: 'head' }));
    for (const r of g.rows) {
      const cy = y + rowH / 2;
      body.push(text(label0, cy, r.model.id, { cls: 'lab', baseline: 'middle' }));
      if (r.memory) {
        body.push(whisker(sm(r.memory.ci[0]), sm(r.memory.ci[1]), cy, 's1'));
        body.push(dot(sm(r.memory.delta), cy, 's1'));
        body.push(
          text(mVal, cy, pp1(r.memory.delta).replace(' pp', ''), {
            cls: 'val',
            baseline: 'middle',
          }),
        );
      } else {
        body.push(text(mVal, cy, 'not run yet', { cls: 'empty', baseline: 'middle' }));
      }
      if (r.qa && r.qa.ratio !== null) {
        body.push(dot(sq(r.qa.ratio), cy, 's1'));
        body.push(text(qVal, cy, pct0(r.qa.ratio), { cls: 'val', baseline: 'middle' }));
      } else {
        body.push(text(qVal, cy, 'not run yet', { cls: 'empty', baseline: 'middle' }));
      }
      body.push(
        hit(
          PAD,
          y,
          W - 2 * PAD,
          rowH,
          `${r.model.id}: ` +
            (r.memory
              ? `memory ${pp1(r.memory.delta)} (95% CI ${ciPp(r.memory.ci)}), off ${pct0(r.memory.off_rate)} → on ${pct0(r.memory.on_rate)}, ${r.memory.verdict}`
              : 'memory not run yet') +
            '; ' +
            (r.qa && r.qa.ratio !== null
              ? `Q&A ${pct1(r.qa.ratio)} of grep-only tokens (run ${r.qa.run})`
              : 'Q&A not run yet'),
        ),
      );
      y += rowH;
    }
  }
  y += 34;
  const ran = rows.filter((r) => r.memory || r.qa).length;
  body.push(
    text(
      PAD,
      y,
      `${ran} of ${rows.length} models measured. Memory bar: pre-registered for anthropic/claude-haiku-5.5 only; for other models it is a reference line.`,
      { cls: 'note' },
    ),
  );
  return svgDoc({
    width: W,
    height: y + 18,
    id: 'cross-model',
    title,
    desc: crossDesc(rows),
    body: body.join('\n'),
  });
};
