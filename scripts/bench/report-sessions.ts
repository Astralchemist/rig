// SPDX-License-Identifier: Apache-2.0
// The sessions-mode report: per-arm session-2 pass rate, trap avoidance,
// tokens and cost per session, waypoints dropped and recalled; then the paired
// memory-on minus memory-off delta with a bootstrap CI, and the verdict
// against the pre-registered bar. `aggregateSessions` is pure so the tests
// can drive it with synthetic results.
import { checkSessionAnswer, toMatcher } from './criteria.ts';
import { median } from './report.ts';
import { BAR_DELTA, BAR_TOKEN_RATIO } from './sessions.ts';
import type {
  CombinedRun,
  MemoryArmName,
  SessionRunResult,
  SessionTask,
  SessionsBenchFile,
} from './types.ts';

export interface Summary {
  median: number;
  mean: number;
}

const summarize = (xs: readonly number[]): Summary | null =>
  xs.length === 0 ? null : { median: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length };

export const s1Tokens = (r: SessionRunResult): number =>
  r.s1 ? r.s1.prompt_tokens + r.s1.completion_tokens : 0;
export const s2Tokens = (r: SessionRunResult): number =>
  r.s2.prompt_tokens + r.s2.completion_tokens;
// Both sessions summed: what the bar's token clause compares.
export const totalTokens = (r: SessionRunResult): number => s1Tokens(r) + s2Tokens(r);

const s1Cost = (r: SessionRunResult): number | null => (r.s1 ? r.s1.cost_usd : 0);
const totalCost = (r: SessionRunResult): number | null => {
  const a = s1Cost(r);
  return a === null || r.s2.cost_usd === null ? null : a + r.s2.cost_usd;
};
const known = (xs: (number | null)[]): number[] => xs.flatMap((x) => (x === null ? [] : [x]));

export interface SessionArmStats {
  arm: MemoryArmName;
  runs: number;
  passed: number;
  pass_rate: number;
  // Over trap tasks' runs that produced an answer: share that hit no trap.
  trap: { runs: number; avoided: number; failed: number; avoidance: number | null };
  errors: number;
  turn_limits: number;
  marker_missing: number;
  tokens: { s1: Summary | null; s2: Summary | null; total: Summary | null };
  cost: { s1: Summary | null; s2: Summary | null; total: Summary | null };
  // Session-1 arms only.
  waypoints: { runs: number; runs_with_drops: number; total: number; mean: number } | null;
  // Arms whose session 2 has rig_waypoints only.
  recall: { runs: number; runs_called: number; runs_recalled: number } | null;
}

export interface PairedDelta {
  pairs: number;
  tasks: number;
  on_rate: number;
  off_rate: number;
  delta: number;
  ci: [number, number];
  on_median_tokens: number;
  off_median_tokens: number;
  token_ratio: number | null;
  token_ratio_ci: [number, number] | null;
  iterations: number;
  seed: number;
}

// memory-auto (pre-registered): its verdict against memory-off on the same
// bar, its comparison with memory-on, and what capture did. Capture recall is
// computed here, after the run, from the stored results; nothing of it
// reached the arm.
export interface CaptureStats {
  runs: number;
  // Records per trial (extracted; stored; injectable), median / mean.
  records: Summary | null;
  stored: Summary | null;
  injectable: Summary | null;
  by_kind: Record<string, number>;
  brief_chars: Summary | null;
  errors: number;
  // Runs of tasks with a usable fact check whose captured records (summary +
  // rationale) match it, and whose brief does.
  recall: { runs: number; captured: number; briefed: number };
  per_task: { id: string; facts: string[]; runs: number; captured: number; briefed: number }[];
}

export interface MemoryAutoReport {
  preregistration: string | null;
  vs_off: { paired: PairedDelta; verdict: VerdictResult } | null;
  vs_on: PairedDelta | null;
  capture: CaptureStats | null;
}

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

export interface TaskRow {
  id: string;
  type: SessionTask['type'];
  trap: boolean;
  cells: Partial<
    Record<MemoryArmName, { runs: number; passed: number; trapped: number; tokens: number }>
  >;
  // memory-on runs whose session 1 dropped at least one waypoint.
  dropped: { runs: number; with_drops: number } | null;
}

export interface SanityRow {
  arm: MemoryArmName;
  trap_runs: number;
  failed: number;
  trapped: number;
  ok: boolean;
}

export interface SessionsReport {
  label: string;
  provider: string;
  model: string;
  resolved_models: string[];
  rig: SessionsBenchFile['rig'];
  target: SessionsBenchFile['target'];
  instructions: SessionsBenchFile['instructions'];
  trap_evidence: SessionsBenchFile['trap_evidence'];
  secret_check: NonNullable<SessionsBenchFile['secret_check']>;
  bar: string;
  confirmation_rule: string | null;
  // The runs a combined report merges; null for a single run.
  combined: CombinedRun[] | null;
  trials: number;
  arms: SessionArmStats[];
  paired: PairedDelta | null;
  verdict: VerdictResult | null;
  sanity: SanityRow[];
  tasks: TaskRow[];
  total_cost: number | null;
  // Present when the memory-auto arm ran.
  memory_auto: MemoryAutoReport | null;
  // A new arm judged against stored baseline runs (addArmsToBaseline).
  added_arms: SessionsBenchFile['added_arms'] | null;
}

// mulberry32: a small seeded PRNG, so a report's CI is reproducible.
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const quantile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

export interface Pair {
  task: string;
  trial: number;
  on: number; // 1 pass, 0 fail
  off: number;
  on_tokens: number;
  off_tokens: number;
}

/**
 * Paired memory-on minus memory-off over (task, trial) pairs, with a two-level
 * (cluster) bootstrap: resample tasks with replacement, then trials within
 * each drawn task. Trials of one task are not independent, so resampling
 * pairs flat would make the interval too narrow.
 */
export const bootstrapPaired = (
  pairs: readonly Pair[],
  opts: { iterations?: number; seed?: number } = {},
): PairedDelta | null => {
  if (pairs.length === 0) return null;
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 20261029;
  const byTask = new Map<string, Pair[]>();
  for (const p of pairs) byTask.set(p.task, [...(byTask.get(p.task) ?? []), p]);
  const groups = [...byTask.values()];
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ratio = (ps: readonly Pair[]): number | null => {
    const off = median(ps.map((p) => p.off_tokens));
    return off > 0 ? median(ps.map((p) => p.on_tokens)) / off : null;
  };
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const deltas: number[] = [];
  const ratios: number[] = [];
  for (let b = 0; b < iterations; b++) {
    const sample: Pair[] = [];
    for (let g = 0; g < groups.length; g++) {
      const group = pick(groups);
      for (let k = 0; k < group.length; k++) sample.push(pick(group));
    }
    deltas.push(mean(sample.map((p) => p.on - p.off)));
    const r = ratio(sample);
    if (r !== null) ratios.push(r);
  }
  deltas.sort((a, b) => a - b);
  ratios.sort((a, b) => a - b);
  const onRate = mean(pairs.map((p) => p.on));
  const offRate = mean(pairs.map((p) => p.off));
  return {
    pairs: pairs.length,
    tasks: groups.length,
    on_rate: onRate,
    off_rate: offRate,
    delta: onRate - offRate,
    ci: [quantile(deltas, 0.025), quantile(deltas, 0.975)],
    on_median_tokens: median(pairs.map((p) => p.on_tokens)),
    off_median_tokens: median(pairs.map((p) => p.off_tokens)),
    token_ratio: ratio(pairs),
    token_ratio_ci: ratios.length ? [quantile(ratios, 0.025), quantile(ratios, 0.975)] : null,
    iterations,
    seed,
  };
};

const pp = (v: number): string => `${(v * 100).toFixed(1)} pp`;
const pc = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * The verdict against the pre-registered bar. The token clause is checked on
 * the point estimate, as the bar states it (median total tokens). The success
 * clause uses the CI: PASS when all of it is at or above +15 pp, FAIL when all
 * of it is below, INCONCLUSIVE when it straddles the threshold. Failing the
 * token clause fails the bar whatever the CI.
 */
export const verdictFor = (
  d: PairedDelta,
  names: { on: MemoryArmName; off: MemoryArmName } = { on: 'memory-on', off: 'memory-off' },
): VerdictResult => {
  const [lo, hi] = d.ci;
  const ci = `95% CI ${pp(lo)} to ${pp(hi)}`;
  if (d.token_ratio === null) {
    return { verdict: 'INCONCLUSIVE', reason: `${names.off} used no tokens; no token ratio` };
  }
  const tokens = `${names.on} used ${pc(d.token_ratio)} of ${names.off}'s median total tokens`;
  if (d.token_ratio > BAR_TOKEN_RATIO) {
    return {
      verdict: 'FAIL',
      reason: `${tokens}, above the ${pc(BAR_TOKEN_RATIO)} cap (success delta ${pp(d.delta)}, ${ci})`,
    };
  }
  if (lo >= BAR_DELTA) {
    return {
      verdict: 'PASS',
      reason: `success delta ${pp(d.delta)}, ${ci}, all ≥ ${pp(BAR_DELTA)}; ${tokens}`,
    };
  }
  if (hi < BAR_DELTA) {
    return {
      verdict: 'FAIL',
      reason: `success delta ${pp(d.delta)}, ${ci}, all below ${pp(BAR_DELTA)}; ${tokens}`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason: `success delta ${pp(d.delta)}, ${ci} straddles ${pp(BAR_DELTA)}; ${tokens}`,
  };
};

const answered = (r: SessionRunResult): boolean => r.s2.final_text.trim() !== '';

/**
 * Aggregate a sessions results file. Pass `tasks` to re-check the stored
 * answers against those criteria instead of the verdicts recorded at run time.
 */
export const aggregateSessions = (
  file: SessionsBenchFile,
  opts: { tasks?: readonly SessionTask[]; iterations?: number; seed?: number } = {},
): SessionsReport => {
  const taskById = new Map((opts.tasks ?? file.tasks).map((t) => [t.id, t]));
  const results = opts.tasks
    ? file.results.map((r) => {
        const t = taskById.get(r.task_id);
        return t
          ? { ...r, check: checkSessionAnswer(r.s2.final_text, t.expected, file.answer_marker) }
          : r;
      })
    : file.results;
  const isTrap = (r: SessionRunResult) => taskById.get(r.task_id)?.trap === true;
  const runsOf = (arm: MemoryArmName) => results.filter((r) => r.arm === arm);

  const arms = file.arms.map((arm): SessionArmStats => {
    const rs = runsOf(arm);
    const trapRuns = rs.filter((r) => isTrap(r) && answered(r));
    const hasS1 = rs.some((r) => r.s1 !== null);
    const recallRuns = rs.filter((r) => r.recalled !== null);
    return {
      arm,
      runs: rs.length,
      passed: rs.filter((r) => r.check.pass).length,
      pass_rate: rs.length ? rs.filter((r) => r.check.pass).length / rs.length : 0,
      trap: {
        runs: trapRuns.length,
        avoided: trapRuns.filter((r) => r.check.trapped.length === 0).length,
        failed: rs.filter((r) => isTrap(r) && !r.check.pass).length,
        avoidance: trapRuns.length
          ? trapRuns.filter((r) => r.check.trapped.length === 0).length / trapRuns.length
          : null,
      },
      errors: rs.filter((r) => r.s2.stop === 'error' || r.s1?.stop === 'error').length,
      turn_limits: rs.filter((r) => r.s2.stop === 'turn_limit').length,
      marker_missing: rs.filter((r) => answered(r) && !r.check.marker_found).length,
      tokens: {
        s1: hasS1 ? summarize(rs.map(s1Tokens)) : null,
        s2: summarize(rs.map(s2Tokens)),
        total: summarize(rs.map(totalTokens)),
      },
      cost: {
        s1: hasS1 ? summarize(known(rs.map(s1Cost))) : null,
        s2: summarize(known(rs.map((r) => r.s2.cost_usd))),
        total: summarize(known(rs.map(totalCost))),
      },
      waypoints: hasS1
        ? {
            runs: rs.length,
            runs_with_drops: rs.filter((r) => r.waypoints.length > 0).length,
            total: rs.reduce((s, r) => s + r.waypoints.length, 0),
            mean: rs.reduce((s, r) => s + r.waypoints.length, 0) / (rs.length || 1),
          }
        : null,
      recall: recallRuns.length
        ? {
            runs: recallRuns.length,
            runs_called: recallRuns.filter((r) => (r.s2.tool_calls.rig_waypoints ?? 0) > 0).length,
            runs_recalled: recallRuns.filter((r) => (r.recalled ?? 0) > 0).length,
          }
        : null,
    };
  });

  // `on` minus `off` over the (task, trial) pairs both ran.
  const pairedFor = (onArm: MemoryArmName, offArm: MemoryArmName): PairedDelta | null => {
    if (!file.arms.includes(onArm) || !file.arms.includes(offArm)) return null;
    const key = (r: SessionRunResult) => `${r.task_id}\u0000${r.trial}`;
    const off = new Map(runsOf(offArm).map((r) => [key(r), r]));
    const pairs: Pair[] = runsOf(onArm).flatMap((on) => {
      const o = off.get(key(on));
      return o
        ? [
            {
              task: on.task_id,
              trial: on.trial,
              on: on.check.pass ? 1 : 0,
              off: o.check.pass ? 1 : 0,
              on_tokens: totalTokens(on),
              off_tokens: totalTokens(o),
            },
          ]
        : [];
    });
    return bootstrapPaired(pairs, {
      ...(opts.iterations !== undefined ? { iterations: opts.iterations } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    });
  };
  const paired = pairedFor('memory-on', 'memory-off');

  let memoryAuto: MemoryAutoReport | null = null;
  if (file.arms.includes('memory-auto')) {
    const vsOff = pairedFor('memory-auto', 'memory-off');
    memoryAuto = {
      preregistration: file.memory_auto_preregistration ?? null,
      vs_off: vsOff
        ? { paired: vsOff, verdict: verdictFor(vsOff, { on: 'memory-auto', off: 'memory-off' }) }
        : null,
      vs_on: pairedFor('memory-auto', 'memory-on'),
      capture: captureStats(runsOf('memory-auto'), taskById),
    };
  }

  // Code-only answers should walk into most traps; if they don't, the traps
  // are recoverable from the code and the delta says little about memory.
  const sanity = (['grep-only', 'memory-off'] as const)
    .filter((a) => file.arms.includes(a))
    .map((arm): SanityRow => {
      const rs = runsOf(arm).filter(isTrap);
      const failed = rs.filter((r) => !r.check.pass).length;
      return {
        arm,
        trap_runs: rs.length,
        failed,
        trapped: rs.filter((r) => r.check.trapped.length > 0).length,
        ok: rs.length > 0 && failed * 2 > rs.length,
      };
    });

  const taskIds = [...new Set(results.map((r) => r.task_id))];
  const tasks = taskIds.map((id): TaskRow => {
    const t = taskById.get(id);
    const cells: TaskRow['cells'] = {};
    for (const arm of file.arms) {
      const rs = results.filter((r) => r.arm === arm && r.task_id === id);
      if (rs.length === 0) continue;
      cells[arm] = {
        runs: rs.length,
        passed: rs.filter((r) => r.check.pass).length,
        trapped: rs.filter((r) => r.check.trapped.length > 0).length,
        tokens: median(rs.map(totalTokens)),
      };
    }
    const on = results.filter((r) => r.arm === 'memory-on' && r.task_id === id);
    return {
      id,
      type: t?.type ?? 'decision',
      trap: t?.trap ?? false,
      cells,
      dropped: on.length
        ? { runs: on.length, with_drops: on.filter((r) => r.waypoints.length > 0).length }
        : null,
    };
  });

  const costs = results.map(totalCost);
  return {
    label: file.label,
    provider: file.provider,
    model: file.model,
    resolved_models: [
      ...new Set(
        results.flatMap((r) => [...(r.s1?.resolved_models ?? []), ...r.s2.resolved_models]),
      ),
    ],
    rig: file.rig,
    target: file.target,
    instructions: file.instructions,
    trap_evidence: file.trap_evidence,
    secret_check: file.secret_check ?? [],
    bar: file.preregistered_bar,
    confirmation_rule: file.confirmation_rule ?? null,
    combined: file.combined ?? null,
    trials: file.trials,
    arms,
    paired,
    verdict: paired ? verdictFor(paired) : null,
    sanity,
    tasks,
    total_cost: costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + c!, 0),
    memory_auto: memoryAuto,
    added_arms: file.added_arms ?? null,
  };
};

// The facts capture recall looks for in a task: its secret when it has one;
// otherwise the literal strings of its `all` criteria (or `any`, without
// `all`) and the value side of its `key = value` patterns, when that value
// has at least three letters or digits. A coarse proxy: the criteria are
// written against the ANSWER line, not against what session 1 said.
export const captureFacts = (t: SessionTask): string[] => {
  if (t.secret) return [t.secret];
  const pats = t.expected.all?.length ? t.expected.all : (t.expected.any ?? []);
  return pats.flatMap((p) => {
    const re = /^\/(.*)\/([a-z]*)$/.exec(p);
    if (!re) return [p];
    const value = re[1]!
      .split(/\\s\*=\\s\*|\\s\*=/)
      .slice(1)
      .join('');
    const body = value.replace(/^\[[^\]]*\]\?/, '');
    const letters = body.replace(/\\[a-z]|[^A-Za-z0-9]/g, '');
    return letters.length >= 3 ? [`/${body}/${re[2]}`] : [];
  });
};

const factFound = (facts: readonly string[], text: string): boolean =>
  facts.some((f) => {
    try {
      return toMatcher(f)(text);
    } catch {
      return false;
    }
  });

const captureStats = (
  rs: readonly SessionRunResult[],
  taskById: ReadonlyMap<string, SessionTask>,
): CaptureStats | null => {
  const withCapture = rs.filter((r) => r.capture);
  if (!withCapture.length) return null;
  const by_kind: Record<string, number> = {};
  for (const r of withCapture) {
    for (const c of r.capture!.records) by_kind[c.kind] = (by_kind[c.kind] ?? 0) + 1;
  }
  const per_task = new Map<string, CaptureStats['per_task'][number]>();
  for (const r of withCapture) {
    const t = taskById.get(r.task_id);
    const facts = t ? captureFacts(t) : [];
    const row = per_task.get(r.task_id) ?? {
      id: r.task_id,
      facts,
      runs: 0,
      captured: 0,
      briefed: 0,
    };
    row.runs++;
    if (facts.length) {
      const text = r.capture!.records.map((c) => `${c.summary}\n${c.rationale}`).join('\n');
      if (factFound(facts, text)) row.captured++;
      if (factFound(facts, r.capture!.brief)) row.briefed++;
    }
    per_task.set(r.task_id, row);
  }
  const rows = [...per_task.values()];
  const checked = rows.filter((t) => t.facts.length);
  return {
    runs: withCapture.length,
    records: summarize(withCapture.map((r) => r.capture!.records.length)),
    stored: summarize(withCapture.map((r) => r.capture!.records.filter((c) => c.stored).length)),
    injectable: summarize(
      withCapture.map((r) => r.capture!.records.filter((c) => c.injectable).length),
    ),
    by_kind,
    brief_chars: summarize(withCapture.map((r) => r.capture!.brief.length)),
    errors: withCapture.filter((r) => r.capture!.error).length,
    recall: {
      runs: checked.reduce((s, t) => s + t.runs, 0),
      captured: checked.reduce((s, t) => s + t.captured, 0),
      briefed: checked.reduce((s, t) => s + t.briefed, 0),
    },
    per_task: rows,
  };
};

const int = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : Math.round(v).toLocaleString('en-US');
const money = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `$${v.toFixed(4)}`;
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(0)}%`;
const both = (s: Summary | null, f: (v: number) => string): string =>
  s ? `${f(s.median)} / ${f(s.mean)}` : '–';

export const renderSessionsMarkdown = (r: SessionsReport): string => {
  const L: string[] = [];
  L.push(`# rig bench, multi-session memory — ${r.label}`, '');
  L.push('**Pre-registered bar** (written before any run):', '', `> ${r.bar}`, '');
  if (r.confirmation_rule) {
    L.push('**Confirmation rule** (pre-registered):', '', `> ${r.confirmation_rule}`, '');
  }
  const ma = r.memory_auto;
  if (ma?.preregistration) {
    L.push('**memory-auto** (pre-registered):', '', `> ${ma.preregistration}`, '');
  }
  const scope = r.combined ? `, combined (${r.combined.length} runs)` : '';
  if (r.verdict) {
    L.push(`**Verdict${scope}: ${r.verdict.verdict}** — ${r.verdict.reason}.`, '');
  } else if (!ma) {
    L.push('**Verdict: not computed** — needs both memory-on and memory-off runs.', '');
  }
  if (ma) {
    L.push(
      ma.vs_off
        ? `**Verdict, memory-auto vs memory-off${scope}: ${ma.vs_off.verdict.verdict}** — ${ma.vs_off.verdict.reason}.`
        : '**Verdict, memory-auto vs memory-off: not computed** — needs memory-off runs of the same tasks and trials.',
      '',
    );
    if (ma.vs_on) {
      const d = ma.vs_on;
      L.push(
        `**memory-auto vs memory-on** (descriptive, no bar): success ${pct(d.on_rate)} vs ${pct(d.off_rate)}, delta ${pp(d.delta)} (95% CI ${pp(d.ci[0])} to ${pp(d.ci[1])}); memory-auto used ${d.token_ratio === null ? '–' : pc(d.token_ratio)} of memory-on's median total tokens.`,
        '',
      );
    }
  }
  if (r.added_arms) {
    L.push(
      `**New arm against stored baseline arms**: ${r.added_arms.arms.join(', ')} from \`${r.added_arms.run}\`, paired with the stored trials of the other arms from ${r.added_arms.baseline_runs.map((b) => `\`${b}\``).join(', ')}. Same model, trials, bar, target and turn limit; the baseline ran on an earlier rig build (see the runs below).`,
      '',
    );
  }
  L.push(`- **Provider / model**: ${r.provider} / \`${r.model}\``);
  if (r.resolved_models.length)
    L.push(`- **Resolved model**: ${r.resolved_models.map((m) => `\`${m}\``).join(', ')}`);
  L.push(
    `- **Rig**: ${r.rig.version} @ \`${r.rig.commit?.slice(0, 7) ?? '?'}\`${r.rig.dirty ? ' (dirty)' : ''}, fingerprint \`${r.rig.fingerprint}\``,
  );
  L.push(
    `- **Target**: \`${r.target.repo}\` @ \`${r.target.commit?.slice(0, 10) ?? '?'}\`` +
      (r.target.commit === r.target.expected_commit
        ? ' (pinned)'
        : ` — **not the pinned ${r.target.expected_commit.slice(0, 10)}**`),
  );
  L.push(
    `- **Index snapshot** (every trial starts from a copy): ${int(r.target.snapshot.nodes)} nodes, ${r.target.snapshot.waypoints} waypoints, sha256 \`${r.target.snapshot.sha256.slice(0, 12)}\``,
  );
  L.push(
    `- **Installed instructions quoted**: \`${r.instructions.path}\` (sha256 \`${r.instructions.sha256.slice(0, 12)}\`)`,
  );
  if (r.combined) {
    const prints = new Set(r.combined.map((c) => c.rig.fingerprint));
    L.push(
      `- **Combined runs**: ${r.combined.length}` +
        (prints.size > 1 ? ' — **rig fingerprints differ between runs**' : ''),
    );
    for (const c of r.combined) {
      L.push(
        `  - \`${c.label}\` (${c.started_at.slice(0, 10)}): ${c.tasks.length} tasks, ${c.trials} trials, rig \`${c.rig.commit?.slice(0, 7) ?? '?'}\`${c.rig.dirty ? ' (dirty)' : ''} fingerprint \`${c.rig.fingerprint}\`, snapshot \`${c.snapshot_sha256.slice(0, 12)}\``,
      );
    }
  }
  L.push(`- **Trials**: ${r.trials}; **total cost**: ${money(r.total_cost)}`, '');

  L.push('## Per arm', '');
  L.push(
    'Pass = session 2 passed its check. Trap avoidance is over trap tasks whose session 2 answered. Tokens and cost: median / mean per trial.',
    '',
  );
  L.push(
    '| arm | session-2 pass | trap avoidance | tokens s1 | tokens s2 | tokens total | cost s1 | cost s2 | cost total | errors / turn limits | no ANSWER line |',
  );
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of r.arms) {
    L.push(
      `| ${a.arm} | ${a.passed}/${a.runs} (${pct(a.pass_rate)}) | ${a.trap.runs ? `${a.trap.avoided}/${a.trap.runs} (${pct(a.trap.avoidance)})` : '–'} | ${both(a.tokens.s1, int)} | ${both(a.tokens.s2, int)} | ${both(a.tokens.total, int)} | ${both(a.cost.s1, money)} | ${both(a.cost.s2, money)} | ${both(a.cost.total, money)} | ${a.errors} / ${a.turn_limits} | ${a.marker_missing} |`,
    );
  }
  L.push('');
  if (r.arms.some((a) => a.arm === 'oracle')) {
    L.push(
      'oracle runs no session 1, so its totals are session 2 only. It is an upper bound for interpretation, not part of the verdict.',
      '',
    );
  }

  const memory = r.arms.filter((a) => a.waypoints || a.recall);
  if (memory.length) {
    L.push('## Waypoints', '');
    L.push(
      '| arm | session 1 dropped any | waypoints dropped (total / mean) | session 2 called rig_waypoints | session 2 got session 1 waypoints back |',
    );
    L.push('|---|---:|---:|---:|---:|');
    for (const a of memory) {
      const w = a.waypoints;
      const c = a.recall;
      L.push(
        `| ${a.arm} | ${w ? `${w.runs_with_drops}/${w.runs}` : '–'} | ${w ? `${w.total} / ${w.mean.toFixed(2)}` : '–'} | ${c ? `${c.runs_called}/${c.runs}` : '–'} | ${c ? `${c.runs_recalled}/${c.runs}` : '–'} |`,
      );
    }
    L.push('');
  }

  if (r.paired) {
    const p = r.paired;
    L.push('## Paired: memory-on minus memory-off', '');
    L.push(
      `Over ${p.pairs} (task, trial) pairs from ${p.tasks} tasks. 95% CIs from a ${p.iterations.toLocaleString('en-US')}-draw two-level bootstrap (tasks, then trials within each task), seed ${p.seed}.`,
      '',
    );
    L.push('| measure | memory-off | memory-on | delta / ratio | 95% CI | bar |');
    L.push('|---|---:|---:|---:|---:|---:|');
    L.push(
      `| session-2 success | ${pct(p.off_rate)} | ${pct(p.on_rate)} | ${pp(p.delta)} | ${pp(p.ci[0])} to ${pp(p.ci[1])} | ≥ ${pp(BAR_DELTA)} |`,
    );
    L.push(
      `| median total tokens | ${int(p.off_median_tokens)} | ${int(p.on_median_tokens)} | ${p.token_ratio === null ? '–' : pc(p.token_ratio)} | ${p.token_ratio_ci ? `${pc(p.token_ratio_ci[0])} to ${pc(p.token_ratio_ci[1])}` : '–'} | ≤ ${pc(BAR_TOKEN_RATIO)} |`,
    );
    L.push('');
  }

  if (ma) {
    const pairedTable = (title: string, d: PairedDelta, on: string, off: string): void => {
      L.push(`## Paired: ${on} minus ${off}`, '');
      L.push(
        `${title} Over ${d.pairs} (task, trial) pairs from ${d.tasks} tasks; same bootstrap as above.`,
        '',
      );
      L.push(`| measure | ${off} | ${on} | delta / ratio | 95% CI | bar |`);
      L.push('|---|---:|---:|---:|---:|---:|');
      L.push(
        `| session-2 success | ${pct(d.off_rate)} | ${pct(d.on_rate)} | ${pp(d.delta)} | ${pp(d.ci[0])} to ${pp(d.ci[1])} | ${off === 'memory-off' ? `≥ ${pp(BAR_DELTA)}` : '–'} |`,
      );
      L.push(
        `| median total tokens | ${int(d.off_median_tokens)} | ${int(d.on_median_tokens)} | ${d.token_ratio === null ? '–' : pc(d.token_ratio)} | ${d.token_ratio_ci ? `${pc(d.token_ratio_ci[0])} to ${pc(d.token_ratio_ci[1])}` : '–'} | ${off === 'memory-off' ? `≤ ${pc(BAR_TOKEN_RATIO)}` : '–'} |`,
      );
      L.push('');
    };
    if (ma.vs_off)
      pairedTable('The pre-registered comparison.', ma.vs_off.paired, 'memory-auto', 'memory-off');
    if (ma.vs_on) pairedTable('Descriptive.', ma.vs_on, 'memory-auto', 'memory-on');
    const c = ma.capture;
    if (c) {
      L.push('## Automatic capture (memory-auto)', '');
      L.push(
        'Records the capture pipeline extracted from session 1, per trial (median / mean); stored excludes duplicates; injectable records are the ones the SessionStart brief may show.',
        '',
      );
      L.push('| runs | records | stored | injectable | brief chars | capture errors |');
      L.push('|---:|---:|---:|---:|---:|---:|');
      L.push(
        `| ${c.runs} | ${both(c.records, (v) => v.toFixed(1))} | ${both(c.stored, (v) => v.toFixed(1))} | ${both(c.injectable, (v) => v.toFixed(1))} | ${both(c.brief_chars, int)} | ${c.errors} |`,
        '',
      );
      const kinds = Object.entries(c.by_kind).sort((a, b) => b[1] - a[1]);
      L.push(
        `By kind (all runs): ${kinds.length ? kinds.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}.`,
        '',
      );
      L.push(
        `**Capture recall** (computed after the run; it did not feed the arm): the needed fact was in the captured records in ${c.recall.captured}/${c.recall.runs} runs and in the brief in ${c.recall.briefed}/${c.recall.runs}. The fact is the task's secret, or else the literal strings and \`key = value\` values of its answer criteria — a coarse proxy, since those are written against the ANSWER line. Tasks with no usable fact are marked n/a.`,
        '',
      );
      L.push('| task | fact checked | runs | captured | in brief |');
      L.push('|---|---|---:|---:|---:|');
      for (const t of c.per_task) {
        L.push(
          `| \`${t.id}\` | ${t.facts.length ? t.facts.map((f) => `\`${f.replace(/\|/g, '\\|')}\``).join(', ') : 'n/a'} | ${t.runs} | ${t.facts.length ? t.captured : '–'} | ${t.facts.length ? t.briefed : '–'} |`,
        );
      }
      L.push('');
    }
  }

  if (r.sanity.length || r.trap_evidence.length || r.secret_check.length) {
    L.push('## Sanity: are the answers in the code?', '');
    if (r.trap_evidence.length) {
      const found = r.trap_evidence.filter((e) => e.found).length;
      L.push(
        `- Code evidence for the trap answers found in the target: ${found}/${r.trap_evidence.length}` +
          (found < r.trap_evidence.length
            ? ` — missing: ${r.trap_evidence
                .filter((e) => !e.found)
                .map((e) => `\`${e.task_id}\` ${e.file}`)
                .join(', ')}`
            : ''),
      );
    }
    if (r.secret_check.length) {
      const inCode = r.secret_check.filter((c) => c.in_code);
      L.push(
        `- Session-1 facts absent from the target's files: ${r.secret_check.length - inCode.length}/${r.secret_check.length}` +
          (inCode.length
            ? ` — **found in code**: ${inCode.map((c) => `\`${c.task_id}\``).join(', ')}`
            : ''),
      );
    }
    for (const s of r.sanity) {
      L.push(
        `- ${s.arm} (code only in session 2) failed ${s.failed}/${s.trap_runs} trap-task runs and gave the trap answer in ${s.trapped}: ${s.ok ? 'OK, code alone leads into most traps' : '**WARNING: code alone avoids most traps; the delta says little about memory**'}`,
      );
    }
    L.push('');
  }

  L.push('## Per task', '');
  const names = r.arms.map((a) => a.arm);
  L.push(
    `| task | type | trap | ${names.map((a) => `${a} pass · trapped · tokens`).join(' | ')} | memory-on dropped |`,
  );
  L.push(`|---|---|---|${names.map(() => '---:').join('|')}|---:|`);
  for (const t of r.tasks) {
    const cells = names.map((a) => {
      const c = t.cells[a];
      return c ? `${c.passed}/${c.runs} · ${c.trapped} · ${int(c.tokens)}` : '–';
    });
    L.push(
      `| \`${t.id}\` | ${t.type} | ${t.trap ? 'yes' : ''} | ${cells.join(' | ')} | ${t.dropped ? `${t.dropped.with_drops}/${t.dropped.runs}` : '–'} |`,
    );
  }
  L.push('');
  return L.join('\n') + '\n';
};

// What must match for runs to be judged together: the same procedure on the
// same target, so only the tasks differ.
const MERGE_KEYS: [string, (f: SessionsBenchFile) => unknown][] = [
  ['mode', (f) => f.mode],
  ['model', (f) => f.model],
  ['arms', (f) => [...f.arms].sort()],
  ['trials', (f) => f.trials],
  ['pre-registered bar', (f) => f.preregistered_bar],
  ['target commit', (f) => f.target.commit],
  ['max turns', (f) => f.max_turns],
  ['answer marker', (f) => f.answer_marker],
];

/**
 * Merge sessions results files into one, for a single table and verdict over
 * all their tasks. Refuses runs that differ in anything but their tasks, and
 * runs that share a task (its trials would count twice).
 */
export const mergeSessionsFiles = (files: readonly SessionsBenchFile[]): SessionsBenchFile => {
  const first = files[0];
  if (!first) throw new Error('nothing to merge');
  if (files.length === 1) return first;
  for (const [what, key] of MERGE_KEYS) {
    const want = JSON.stringify(key(first));
    for (const f of files.slice(1)) {
      const got = JSON.stringify(key(f));
      if (got !== want) {
        throw new Error(
          `refusing to merge: ${what} differs (${first.label}: ${want}; ${f.label}: ${got})`,
        );
      }
    }
  }
  const owner = new Map<string, string>();
  for (const f of files) {
    const ids = new Set([...f.tasks.map((t) => t.id), ...f.results.map((r) => r.task_id)]);
    for (const id of ids) {
      const prev = owner.get(id);
      if (prev !== undefined) {
        throw new Error(`refusing to merge: task ${id} is in both ${prev} and ${f.label}`);
      }
      owner.set(id, f.label);
    }
  }
  const rule = files.find((f) => f.confirmation_rule)?.confirmation_rule;
  const prereg = files.find((f) => f.memory_auto_preregistration)?.memory_auto_preregistration;
  const finished = files.map((f) => f.finished_at);
  return {
    ...first,
    label: files.map((f) => f.label).join(' + '),
    started_at: files.map((f) => f.started_at).sort()[0]!,
    finished_at: finished.some((t) => t === null) ? null : (finished as string[]).sort().at(-1)!,
    ...(rule !== undefined ? { confirmation_rule: rule } : {}),
    ...(prereg !== undefined ? { memory_auto_preregistration: prereg } : {}),
    trap_evidence: files.flatMap((f) => f.trap_evidence),
    secret_check: files.flatMap((f) => f.secret_check ?? []),
    tasks: files.flatMap((f) => f.tasks),
    results: files.flatMap((f) => f.results),
    combined: files.map((f) => ({
      label: f.label,
      started_at: f.started_at,
      rig: f.rig,
      snapshot_sha256: f.target.snapshot.sha256,
      tasks: f.tasks.map((t) => t.id),
      trials: f.results.length,
    })),
  };
};

const runOf = (f: SessionsBenchFile): CombinedRun => ({
  label: f.label,
  started_at: f.started_at,
  rig: f.rig,
  snapshot_sha256: f.target.snapshot.sha256,
  tasks: f.tasks.map((t) => t.id),
  trials: f.results.length,
});

/**
 * A new arm against stored baseline arms: `added` ran only arms the baseline
 * did not (`--arms memory-auto`), on tasks the baseline covers, with the same
 * model, trials, bar, target, turn limit and marker. Its results join the
 * baseline's, so each new trial pairs with the stored trial of the same task
 * and index. The baseline (one file, or several merged with
 * mergeSessionsFiles first) keeps its own runs; this is the only way runs
 * with different arms are judged together, and the report says so.
 */
export const addArmsToBaseline = (
  baseline: SessionsBenchFile,
  added: SessionsBenchFile,
): SessionsBenchFile => {
  for (const [what, key] of MERGE_KEYS.filter(([w]) => w !== 'arms')) {
    const want = JSON.stringify(key(baseline));
    const got = JSON.stringify(key(added));
    if (got !== want) {
      throw new Error(
        `refusing to add arms: ${what} differs (baseline: ${want}; ${added.label}: ${got})`,
      );
    }
  }
  const shared = added.arms.filter((a) => baseline.arms.includes(a));
  if (shared.length) {
    throw new Error(
      `refusing to add arms: ${shared.join(', ')} already in the baseline; run only the new arm`,
    );
  }
  const base = new Map(baseline.tasks.map((t) => [t.id, t]));
  for (const t of added.tasks) {
    const b = base.get(t.id);
    if (!b) throw new Error(`refusing to add arms: task ${t.id} is not in the baseline`);
    if (JSON.stringify(b) !== JSON.stringify(t)) {
      throw new Error(`refusing to add arms: task ${t.id} differs from the baseline's`);
    }
  }
  const baselineRuns = baseline.combined ?? [runOf(baseline)];
  return {
    ...baseline,
    label: `${baseline.label} + ${added.label}`,
    finished_at: added.finished_at,
    ...(added.memory_auto_preregistration !== undefined
      ? { memory_auto_preregistration: added.memory_auto_preregistration }
      : {}),
    arms: [...baseline.arms, ...added.arms],
    results: [...baseline.results, ...added.results],
    combined: [...baselineRuns, runOf(added)],
    added_arms: {
      arms: added.arms,
      run: added.label,
      baseline_runs: baselineRuns.map((r) => r.label),
    },
  };
};
