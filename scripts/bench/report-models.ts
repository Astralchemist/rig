// SPDX-License-Identifier: Apache-2.0
// The by-model view: one row per model in the manifest, with its memory delta
// (memory-on minus memory-off, bootstrap CI, checked against the bar) and its
// single-shot token ratio (grep+rig against grep-only). The cross-model chart
// draws the same rows. `modelRows` is pure apart from the loader it is given.
import { aggregate } from './report.ts';
import { aggregateSessions, mergeSessionsFiles, type Verdict } from './report-sessions.ts';
import { BAR_DELTA } from './sessions.ts';
import {
  abortReason,
  isSessionsFile,
  type AnyBenchFile,
  type BenchIndex,
  type IndexModel,
  type IndexRun,
} from './models.ts';
import type { BenchFile, SessionsBenchFile } from './types.ts';

// The single-shot comparison every model is measured on: the arm an agent has
// in real use against grep and file reads alone.
export const QA_ARM = 'grep+rig';
export const QA_BASE = 'baseline';

export interface MemoryRow {
  // Labels of the runs merged into this row, oldest first.
  runs: string[];
  tasks: number;
  trials: number;
  pairs: number;
  off_rate: number;
  on_rate: number;
  delta: number;
  ci: [number, number];
  token_ratio: number | null;
  verdict: Verdict;
  reason: string;
}

export interface QaRow {
  run: string;
  queries: number;
  trials: number;
  // Median over queries of (grep+rig median tokens ÷ baseline median tokens).
  ratio: number | null;
  arm_correct: number;
  arm_runs: number;
  base_correct: number;
  base_runs: number;
}

export interface ModelRow {
  model: IndexModel;
  memory: MemoryRow | null;
  qa: QaRow | null;
  // Labels of runs left out because they were aborted (see abortReason): a
  // mode with no row but an aborted run shows "aborted", never 0%.
  aborted: { sessions: string[]; qa: string[] };
  resolved_models: string[];
  spent_usd: number;
}

const newestFirst = <T extends { started_at: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));

/**
 * The sessions evidence for one model: its runs that have both memory arms
 * and weren't aborted,
 * newest first, each merged in when it is compatible with those already taken
 * (same arms, trials, bar and target; no shared task). A full newer run thus
 * replaces older partial ones, and complementary task sets (the first run
 * plus its confirmation) combine as the report combines them.
 */
export const selectSessions = (files: readonly SessionsBenchFile[]): SessionsBenchFile | null => {
  const candidates = newestFirst(
    files.filter(
      (f) => !abortReason(f) && f.arms.includes('memory-on') && f.arms.includes('memory-off'),
    ),
  );
  const chosen: SessionsBenchFile[] = [];
  for (const f of candidates) {
    try {
      mergeSessionsFiles([...chosen, f]);
      chosen.push(f);
    } catch {
      // Overlaps or differs from a newer run: the newer one stands.
    }
  }
  if (chosen.length === 0) return null;
  return mergeSessionsFiles(chosen.reverse());
};

// The newest single-shot run that has both comparison arms (aborted runs never count).
export const selectQa = (files: readonly BenchFile[]): BenchFile | null =>
  newestFirst(
    files.filter((f) => !abortReason(f) && f.arms.includes(QA_ARM) && f.arms.includes(QA_BASE)),
  )[0] ?? null;

export const memoryRow = (file: SessionsBenchFile): MemoryRow | null => {
  const r = aggregateSessions(file);
  if (!r.paired || !r.verdict) return null;
  return {
    runs: r.combined ? r.combined.map((c) => c.label) : [file.label],
    tasks: new Set(file.results.map((x) => x.task_id)).size,
    trials: file.trials,
    pairs: r.paired.pairs,
    off_rate: r.paired.off_rate,
    on_rate: r.paired.on_rate,
    delta: r.paired.delta,
    ci: r.paired.ci,
    token_ratio: r.paired.token_ratio,
    verdict: r.verdict.verdict,
    reason: r.verdict.reason,
  };
};

export const qaRow = (file: BenchFile): QaRow | null => {
  const r = aggregate(file);
  const arm = r.arms.find((a) => a.arm === QA_ARM);
  const base = r.arms.find((a) => a.arm === QA_BASE);
  if (!arm || !base || !arm.paired) return null;
  return {
    run: file.label,
    queries: arm.paired.queries,
    trials: file.trials,
    ratio: arm.paired.median_token_ratio,
    arm_correct: arm.correct,
    arm_runs: arm.runs,
    base_correct: base.correct,
    base_runs: base.runs,
  };
};

/** One row per model in the manifest (lineup order, then the rest). */
export const modelRows = (index: BenchIndex, load: (run: IndexRun) => AnyBenchFile): ModelRow[] =>
  index.models.map((model): ModelRow => {
    const runs = index.runs.filter((r) => r.model === model.id);
    const loaded = runs.map(load);
    const files = loaded.filter((f) => abortReason(f) === null);
    const void_ = loaded.filter((f) => abortReason(f) !== null);
    const sessions = selectSessions(files.filter(isSessionsFile));
    const qa = selectQa(files.filter((f): f is BenchFile => !isSessionsFile(f)));
    return {
      model,
      memory: sessions ? memoryRow(sessions) : null,
      qa: qa ? qaRow(qa) : null,
      aborted: {
        sessions: void_.filter(isSessionsFile).map((f) => f.label),
        qa: void_.filter((f) => !isSessionsFile(f)).map((f) => f.label),
      },
      resolved_models: [...new Set(runs.flatMap((r) => r.resolved_models))].sort(),
      spent_usd: Math.round(runs.reduce((s, r) => s + r.cost_usd, 0) * 1e6) / 1e6,
    };
  });

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const pp = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pp`;
const price = (m: IndexModel): string =>
  m.input_usd_per_m === null || m.output_usd_per_m === null
    ? '–'
    : `${m.input_usd_per_m.toFixed(2)} · ${m.output_usd_per_m.toFixed(2)}`;

export const renderByModelMarkdown = (index: BenchIndex, rows: readonly ModelRow[]): string => {
  const L: string[] = [];
  L.push('# rig bench — by model', '');
  L.push(
    `Tiers by input list price: low-cost below $${index.tier_threshold_usd_per_m_input.toFixed(2)} per million tokens, frontier at or above` +
      (index.prices_as_of ? ` (OpenRouter prices as of ${index.prices_as_of}).` : '.'),
    '',
  );
  L.push('Fairness:', '', ...index.fairness.map((f) => `- ${f}`), '');
  L.push('## Multi-session memory', '');
  L.push(
    `Session-2 success, memory-on minus memory-off over the same (task, trial) pairs, with the report's two-level bootstrap CI. "Against the bar" applies the pre-registered rule (whole CI ≥ +${(BAR_DELTA * 100).toFixed(0)} pp, tokens ≤ 110%); it was registered for \`anthropic/claude-haiku-5.5\`, so for other models it is a reading, not a pre-registered verdict.`,
    '',
  );
  L.push(
    '| model | tier | $ / M in · out | memory-off | memory-on | delta (95% CI) | token ratio | against the bar | tasks × trials | runs |',
  );
  L.push('|---|---|---:|---:|---:|---:|---:|---|---:|---|');
  for (const r of rows) {
    const m = r.memory;
    L.push(
      `| \`${r.model.id}\` | ${r.model.tier ?? '–'} | ${price(r.model)} | ` +
        (m
          ? `${pct(m.off_rate)} | ${pct(m.on_rate)} | ${pp(m.delta)} (${pp(m.ci[0])} to ${pp(m.ci[1])}) | ${m.token_ratio === null ? '–' : pct(m.token_ratio)} | ${m.verdict} | ${m.tasks} × ${m.trials} | ${m.runs.map((x) => `\`${x}\``).join(' + ')} |`
          : `${r.aborted.sessions.length ? `aborted (insufficient credits): ${r.aborted.sessions.map((x) => `\`${x}\``).join(', ')}` : 'not run yet'} | | | | | | |`),
    );
  }
  L.push('');
  L.push('## Single-shot Q&A', '');
  L.push(
    `Median over queries of (${QA_ARM} median tokens ÷ grep-only median tokens), paired per query; below 100% means ${QA_ARM} was cheaper. The newest run with both arms per model.`,
    '',
  );
  L.push(
    '| model | tier | token ratio | correct (grep+rig) | correct (grep-only) | queries × trials | run |',
  );
  L.push('|---|---|---:|---:|---:|---:|---|');
  for (const r of rows) {
    const q = r.qa;
    L.push(
      `| \`${r.model.id}\` | ${r.model.tier ?? '–'} | ` +
        (q
          ? `${q.ratio === null ? '–' : `${(q.ratio * 100).toFixed(1)}%`} | ${q.arm_correct}/${q.arm_runs} | ${q.base_correct}/${q.base_runs} | ${q.queries} × ${q.trials} | \`${q.run}\` |`
          : `${r.aborted.qa.length ? `aborted (insufficient credits): ${r.aborted.qa.map((x) => `\`${x}\``).join(', ')}` : 'not run yet'} | | | | |`),
    );
  }
  L.push('');
  const flagged = index.runs.filter((r) => r.credit_error_trials > 0);
  if (flagged.length) {
    L.push(
      `Runs that recorded credits errors (HTTP 402) as model failures, from before those errors stopped a run; such trials count as failed: ${flagged.map((r) => `\`${r.label}\` (${r.credit_error_trials})`).join(', ')}.`,
      '',
    );
  }
  L.push('## Models', '');
  L.push(
    '| model | vendor | catalogue snapshot | resolved by the API | tools | reasoning default | spent |',
  );
  L.push('|---|---|---|---|---|---|---:|');
  for (const r of rows) {
    const m = r.model;
    const reasoning = m.reasoning
      ? m.reasoning.mandatory
        ? 'always on'
        : m.reasoning.default_enabled
          ? 'on'
          : 'off'
      : '–';
    L.push(
      `| \`${m.id}\` | ${m.vendor} | ${m.canonical_slug ? `\`${m.canonical_slug}\`` : '–'} | ${r.resolved_models.length ? r.resolved_models.map((x) => `\`${x}\``).join(', ') : '–'} | ${m.tools === null ? '?' : m.tools ? 'yes' : '**no**'} | ${reasoning} | $${r.spent_usd.toFixed(4)} |`,
    );
  }
  L.push('');
  return L.join('\n') + '\n';
};
