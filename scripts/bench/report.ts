// SPDX-License-Identifier: Apache-2.0
// Turn a results file into a markdown report: per-arm correctness, tokens,
// cost and tool turns, then paired per-query comparisons against baseline.
// `aggregate` is pure so the tests can drive it with synthetic results.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkAnswer } from './criteria.ts';
import type {
  ArmName,
  BenchFile,
  Query,
  QueriesFile,
  RunResult,
  SessionsBenchFile,
} from './types.ts';

export interface Summary {
  median: number;
  mean: number;
}

export interface ArmStats {
  arm: ArmName;
  runs: number;
  correct: number;
  correct_rate: number;
  errors: number;
  turn_limits: number;
  tokens_all: Summary | null;
  tokens_correct: Summary | null;
  // null when no run in the set has a known cost.
  cost_all: Summary | null;
  cost_correct: Summary | null;
  tool_turns: Summary | null;
  model_calls: Summary | null;
  by_category: Partial<
    Record<Query['category'], { runs: number; correct_rate: number; tokens: Summary | null }>
  >;
  judge: { judged: number; correct_rate: number; agreement: number } | null;
  // Against baseline, one point per query; null for baseline itself.
  paired: {
    queries: number;
    median_token_ratio: number | null;
    median_token_ratio_both_correct: number | null;
    correct_cheaper: number;
    correct_pricier: number;
    wrong: number;
    baseline_wrong: number;
  } | null;
}

export interface QueryCell {
  runs: number;
  correct: number;
  tokens: number | null;
  cost: number | null;
  tool_turns: number | null;
}

export interface QueryRow {
  id: string;
  category: Query['category'];
  cells: Partial<Record<ArmName, QueryCell>>;
}

export interface Failure {
  query_id: string;
  arm: ArmName;
  failed: number;
  runs: number;
  missing: string[];
  forbidden: string[];
  stops: string[];
  sample: string;
}

export interface Report {
  label: string;
  provider: string;
  model: string;
  resolved_models: string[];
  judge_model: string | null;
  rig: BenchFile['rig'];
  target: BenchFile['target'];
  overview: BenchFile['overview'] | null;
  trials: number;
  arms: ArmStats[];
  queries: QueryRow[];
  failures: Failure[];
  total_cost: number | null;
}

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};

const summarize = (xs: readonly number[]): Summary | null =>
  xs.length === 0 ? null : { median: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length };

const tokens = (r: RunResult): number => r.prompt_tokens + r.completion_tokens;
const costs = (rs: readonly RunResult[]): number[] =>
  rs.flatMap((r) => (r.cost_usd === null ? [] : [r.cost_usd]));

// A query counts as answered correctly by an arm when at least half its
// trials passed the check.
const mostlyCorrect = (rs: readonly RunResult[]): boolean =>
  rs.length > 0 && rs.filter((r) => r.check.pass).length * 2 >= rs.length;

/**
 * Aggregate a results file. Pass `queries` to re-check every stored answer
 * against those criteria instead of the verdicts recorded at run time.
 */
export const aggregate = (file: BenchFile, opts: { queries?: readonly Query[] } = {}): Report => {
  const qById = new Map((opts.queries ?? file.queries).map((q) => [q.id, q]));
  const results = opts.queries
    ? file.results.map((r) => {
        const q = qById.get(r.query_id);
        return q ? { ...r, check: checkAnswer(r.final_text, q.expected) } : r;
      })
    : file.results;
  const queryIds = [...new Set(results.map((r) => r.query_id))];
  const runsOf = (arm: ArmName, qid?: string): RunResult[] =>
    results.filter((r) => r.arm === arm && (qid === undefined || r.query_id === qid));

  const arms = file.arms.map((arm): ArmStats => {
    const rs = runsOf(arm);
    const ok = rs.filter((r) => r.check.pass);
    const byCategory: ArmStats['by_category'] = {};
    for (const cat of ['lookup', 'natural'] as const) {
      const cr = rs.filter((r) => qById.get(r.query_id)?.category === cat);
      if (cr.length === 0) continue;
      byCategory[cat] = {
        runs: cr.length,
        correct_rate: cr.filter((r) => r.check.pass).length / cr.length,
        tokens: summarize(cr.map(tokens)),
      };
    }
    const judged = rs.filter((r) => r.judge && r.judge.verdict !== 'error');
    let paired: ArmStats['paired'] = null;
    if (arm !== 'baseline' && file.arms.includes('baseline')) {
      const ratios: number[] = [];
      const bothRatios: number[] = [];
      let cheaper = 0;
      let pricier = 0;
      let wrong = 0;
      let baseWrong = 0;
      let n = 0;
      for (const qid of queryIds) {
        const a = runsOf(arm, qid);
        const b = runsOf('baseline', qid);
        if (a.length === 0 || b.length === 0) continue;
        n++;
        const aTok = median(a.map(tokens));
        const bTok = median(b.map(tokens));
        const aOk = mostlyCorrect(a);
        const bOk = mostlyCorrect(b);
        if (bTok > 0) {
          ratios.push(aTok / bTok);
          if (aOk && bOk) bothRatios.push(aTok / bTok);
        }
        if (!bOk) baseWrong++;
        if (!aOk) wrong++;
        else if (aTok < bTok) cheaper++;
        else pricier++;
      }
      paired = {
        queries: n,
        median_token_ratio: ratios.length ? median(ratios) : null,
        median_token_ratio_both_correct: bothRatios.length ? median(bothRatios) : null,
        correct_cheaper: cheaper,
        correct_pricier: pricier,
        wrong,
        baseline_wrong: baseWrong,
      };
    }
    return {
      arm,
      runs: rs.length,
      correct: ok.length,
      correct_rate: rs.length ? ok.length / rs.length : 0,
      errors: rs.filter((r) => r.stop === 'error').length,
      turn_limits: rs.filter((r) => r.stop === 'turn_limit').length,
      tokens_all: summarize(rs.map(tokens)),
      tokens_correct: summarize(ok.map(tokens)),
      cost_all: summarize(costs(rs)),
      cost_correct: summarize(costs(ok)),
      tool_turns: summarize(rs.map((r) => r.tool_turns)),
      model_calls: summarize(rs.map((r) => r.model_calls)),
      by_category: byCategory,
      judge: judged.length
        ? {
            judged: judged.length,
            correct_rate:
              judged.filter((r) => r.judge!.verdict === 'correct').length / judged.length,
            agreement:
              judged.filter((r) => (r.judge!.verdict === 'correct') === r.check.pass).length /
              judged.length,
          }
        : null,
      paired,
    };
  });

  const queries = queryIds.map((id): QueryRow => {
    const cells: QueryRow['cells'] = {};
    for (const arm of file.arms) {
      const rs = runsOf(arm, id);
      if (rs.length === 0) continue;
      const c = costs(rs);
      cells[arm] = {
        runs: rs.length,
        correct: rs.filter((r) => r.check.pass).length,
        tokens: median(rs.map(tokens)),
        cost: c.length ? median(c) : null,
        tool_turns: median(rs.map((r) => r.tool_turns)),
      };
    }
    return { id, category: qById.get(id)?.category ?? 'lookup', cells };
  });

  const failures: Failure[] = [];
  for (const id of queryIds) {
    for (const arm of file.arms) {
      const rs = runsOf(arm, id);
      const bad = rs.filter((r) => !r.check.pass);
      if (bad.length === 0) continue;
      failures.push({
        query_id: id,
        arm,
        failed: bad.length,
        runs: rs.length,
        missing: [...new Set(bad.flatMap((r) => r.check.missing))],
        forbidden: [...new Set(bad.flatMap((r) => r.check.forbidden))],
        stops: [...new Set(bad.map((r) => (r.error ? `error: ${r.error.slice(0, 80)}` : r.stop)))],
        sample: bad[0]!.final_text,
      });
    }
  }

  const allCosts = results.map((r) =>
    r.cost_usd === null || (r.judge && r.judge.cost_usd === null)
      ? null
      : r.cost_usd + (r.judge?.cost_usd ?? 0),
  );
  return {
    label: file.label,
    provider: file.provider,
    model: file.model,
    resolved_models: [...new Set(results.flatMap((r) => r.resolved_models))],
    judge_model: file.judge_model,
    rig: file.rig,
    target: file.target,
    overview: file.overview ?? null,
    trials: file.trials,
    arms,
    queries,
    failures,
    total_cost: allCosts.some((c) => c === null)
      ? null
      : allCosts.reduce<number>((s, c) => s + c!, 0),
  };
};

const int = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : Math.round(v).toLocaleString('en-US');
const money = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `$${v.toFixed(4)}`;
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(0)}%`;
const ratio = (v: number | null): string => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);
const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t || '(empty)';
};

export const renderMarkdown = (r: Report): string => {
  const L: string[] = [];
  L.push(`# rig bench — ${r.label}`, '');
  L.push(`- **Provider / model**: ${r.provider} / \`${r.model}\``);
  if (r.resolved_models.length)
    L.push(`- **Resolved model**: ${r.resolved_models.map((m) => `\`${m}\``).join(', ')}`);
  if (r.judge_model) L.push(`- **Judge**: \`${r.judge_model}\``);
  L.push(
    `- **Rig**: ${r.rig.version} @ \`${r.rig.commit?.slice(0, 7) ?? '?'}\`${r.rig.dirty ? ' (dirty)' : ''}, fingerprint \`${r.rig.fingerprint}\``,
  );
  L.push(
    `- **Target**: \`${r.target.repo}\` @ \`${r.target.commit?.slice(0, 10) ?? '?'}\`` +
      (r.target.commit === r.target.expected_commit
        ? ' (pinned)'
        : ` — **not the pinned ${r.target.expected_commit.slice(0, 10)}**`) +
      (r.target.index.nodes
        ? `, ${int(r.target.index.nodes)} nodes / ${int(r.target.index.files)} files`
        : ''),
  );
  if (r.overview) {
    L.push(
      `- **Repository overview** (grep+rig+map system prompt): ${int(r.overview.chars)} chars ≈ ${int(r.overview.est_tokens)} tokens, budget ${int(r.overview.budget_tokens)}` +
        (r.overview.cached
          ? ', from the index cache'
          : `, generated in ${r.overview.elapsed_ms} ms`),
    );
  }
  L.push(`- **Trials**: ${r.trials}; **total cost**: ${money(r.total_cost)}`, '');

  L.push('## Per arm', '');
  L.push(
    '| arm | correct | tokens median (all / correct) | tokens mean (all / correct) | cost median (all / correct) | cost mean (all / correct) | tool turns (median / mean) | errors / turn limits |',
  );
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of r.arms) {
    L.push(
      `| ${a.arm} | ${a.correct}/${a.runs} (${pct(a.correct_rate)}) | ${int(a.tokens_all?.median)} / ${int(a.tokens_correct?.median)} | ${int(a.tokens_all?.mean)} / ${int(a.tokens_correct?.mean)} | ${money(a.cost_all?.median)} / ${money(a.cost_correct?.median)} | ${money(a.cost_all?.mean)} / ${money(a.cost_correct?.mean)} | ${a.tool_turns ? `${a.tool_turns.median} / ${a.tool_turns.mean.toFixed(1)}` : '–'} | ${a.errors} / ${a.turn_limits} |`,
    );
  }
  L.push('');

  const paired = r.arms.filter((a) => a.paired);
  if (paired.length) {
    L.push('## Paired against baseline (per query, median over trials)', '');
    L.push(
      'A query counts as correct for an arm when at least half its trials pass the check.',
      '',
    );
    L.push(
      '| arm | queries | median token ratio | ratio, both correct | correct & cheaper | correct but pricier | wrong | baseline wrong |',
    );
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const a of paired) {
      const p = a.paired!;
      L.push(
        `| ${a.arm} | ${p.queries} | ${ratio(p.median_token_ratio)} | ${ratio(p.median_token_ratio_both_correct)} | ${p.correct_cheaper} | ${p.correct_pricier} | ${p.wrong} | ${p.baseline_wrong} |`,
      );
    }
    L.push('');
  }

  L.push('## By query category', '');
  L.push(
    '| arm | lookup correct | lookup median tokens | natural correct | natural median tokens |',
  );
  L.push('|---|---:|---:|---:|---:|');
  for (const a of r.arms) {
    const l = a.by_category.lookup;
    const n = a.by_category.natural;
    L.push(
      `| ${a.arm} | ${pct(l?.correct_rate)} | ${int(l?.tokens?.median)} | ${pct(n?.correct_rate)} | ${int(n?.tokens?.median)} |`,
    );
  }
  L.push('');

  const judged = r.arms.filter((a) => a.judge);
  if (judged.length) {
    L.push('## LLM judge (second opinion)', '');
    L.push('| arm | judged | judge says correct | agrees with check |');
    L.push('|---|---:|---:|---:|');
    for (const a of judged) {
      L.push(
        `| ${a.arm} | ${a.judge!.judged} | ${pct(a.judge!.correct_rate)} | ${pct(a.judge!.agreement)} |`,
      );
    }
    L.push('');
  }

  L.push('## Per query (median over trials)', '');
  const armNames = r.arms.map((a) => a.arm);
  L.push(`| query | kind | ${armNames.map((a) => `${a} ok · tokens · cost`).join(' | ')} |`);
  L.push(`|---|---|${armNames.map(() => '---:').join('|')}|`);
  for (const q of r.queries) {
    const cells = armNames.map((a) => {
      const c = q.cells[a];
      return c ? `${c.correct}/${c.runs} · ${int(c.tokens)} · ${money(c.cost)}` : '–';
    });
    L.push(`| \`${q.id}\` | ${q.category} | ${cells.join(' | ')} |`);
  }
  L.push('');

  if (r.failures.length) {
    L.push('## Failed checks', '');
    for (const f of r.failures) {
      const why = [
        f.missing.length ? `missing ${f.missing.map((m) => `\`${m}\``).join(', ')}` : '',
        f.forbidden.length ? `forbidden ${f.forbidden.map((m) => `\`${m}\``).join(', ')}` : '',
        f.stops.filter((s) => s !== 'answer').join(', '),
      ]
        .filter(Boolean)
        .join('; ');
      L.push(
        `- \`${f.query_id}\` / ${f.arm}: ${f.failed}/${f.runs} failed${why ? ` — ${why}` : ''}`,
      );
      L.push(`  > ${oneLine(f.sample, 300)}`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valued = new Set(['--in', '--out', '--queries-file', '--sessions-file']);
  const value = (n: string): string | undefined => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  const inPath = value('--in') ?? positional[0];
  if (!inPath) {
    console.error(
      'usage: bun scripts/bench/report.ts <results.json> [--out report.md] [--recheck [--queries-file queries.json | --sessions-file sessions.json]]',
    );
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as BenchFile | SessionsBenchFile;
  const write = (md: string): void => {
    const outPath = value('--out');
    if (outPath) {
      writeFileSync(resolve(outPath), md);
      console.log(`wrote ${resolve(outPath)}`);
    } else {
      process.stdout.write(md);
    }
  };
  if ('mode' in raw && raw.mode === 'sessions') {
    // Loaded here, not at the top: report-sessions.ts imports this module.
    const { aggregateSessions, renderSessionsMarkdown } = await import('./report-sessions.ts');
    const { loadSessionsFile } = await import('./sessions.ts');
    const tasks = args.includes('--recheck')
      ? loadSessionsFile(value('--sessions-file') ?? resolve(import.meta.dir, 'sessions.json'))
          .tasks
      : undefined;
    write(renderSessionsMarkdown(aggregateSessions(raw, tasks ? { tasks } : {})));
    process.exit(0);
  }
  const file = raw as BenchFile;
  // --recheck: grade the stored answers against the current criteria.
  const queries = args.includes('--recheck')
    ? (
        JSON.parse(
          readFileSync(
            value('--queries-file') ?? resolve(import.meta.dir, 'queries.json'),
            'utf-8',
          ),
        ) as QueriesFile
      ).queries
    : undefined;
  write(renderMarkdown(aggregate(file, queries ? { queries } : {})));
}
