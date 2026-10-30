// SPDX-License-Identifier: Apache-2.0
// The pre-registered impact evaluation (README.md): replay rig's history,
// and per commit compare rig's predicted blast radius with the one observed
// in the parent's test run. Everything is measured at the commit's parent.
//
//   bun run scripts/impact-eval/replay.ts [--from fd36ac5] [--take 60] [--work <dir>]
//
// Writes results/<date>-impact-eval.json and .md next to this file.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Rig } from '../../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../../packages/core/src/embed/deterministic-embedder.ts';
import {
  diffImpact,
  innermostSymbolAt,
  innermostSymbols,
  parseUnifiedDiff,
  symbolsInFile,
  type LineRange,
} from '../../packages/core/src/graph/diff-impact.ts';
import { renderImpactText } from '../../packages/cli/src/impact-cmd.ts';

const REPO = resolve(import.meta.dir, '../..');
const RECORDER = resolve(import.meta.dir, 'record.ts');
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const FROM = arg('--from', 'fd36ac5');
const TAKE = Number(arg('--take', '60'));
const MIN_SCORED = 50;
const WORK_ARG = resolve(arg('--work', join(tmpdir(), 'rig-impact-eval')));
mkdirSync(WORK_ARG, { recursive: true });
// Real path: macOS's tmpdir is behind a symlink, and stack traces report the
// real path, which would never match the worktree's.
const WORK = realpathSync(WORK_ARG);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const sh = (cmd: string, args: string[], cwd: string, timeout = 5 * 60 * 1000) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout, maxBuffer: 256 * 1024 * 1024 });
const git = (args: string[], cwd = REPO): string => {
  const r = sh('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// In scope: the product's TypeScript, not tests, generated code or scripts.
const inScope = (path: string): boolean =>
  path.startsWith('packages/') &&
  /\.(ts|tsx)$/.test(path) &&
  !/(^|\/)__tests__\//.test(path) &&
  !/\.test\.tsx?$/.test(path);
const isTestPath = (path: string | null): boolean =>
  !!path &&
  (/(^|\/)__tests__\//.test(path) || /\.test\.tsx?$/.test(path) || path.startsWith('e2e/'));

interface CommitResult {
  commit: string;
  subject: string;
  status: 'scored' | 'not-executed' | 'not-qualifying' | 'skipped';
  reason?: string;
  changed: number;
  changedExecuted: number;
  predicted: number;
  observed: number;
  hit: number;
  baselinePredicted: number;
  baselineHit: number;
  unbounded: { predicted: number; observed: number; hit: number };
  textLines: number;
  missed: string[];
  /** Call edges recorded, and how many mapped to a symbol at both ends. */
  edges: number;
  edgesMapped: number;
  ms: number;
}

const reverseReach = (
  starts: Set<string>,
  incoming: Map<string, Set<string>>,
  depth: number,
): Set<string> => {
  const seen = new Set<string>(starts);
  let frontier = [...starts];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const src of incoming.get(id) ?? [])
        if (!seen.has(src)) {
          seen.add(src);
          next.push(src);
        }
    frontier = next;
  }
  for (const s of starts) seen.delete(s);
  return seen;
};

const replayCommit = async (sha: string, wt: string): Promise<CommitResult> => {
  const t0 = Date.now();
  const subject = git(['log', '-1', '--format=%s', sha]).trim();
  const base: CommitResult = {
    commit: sha.slice(0, 7),
    subject,
    status: 'skipped',
    changed: 0,
    changedExecuted: 0,
    predicted: 0,
    observed: 0,
    hit: 0,
    baselinePredicted: 0,
    baselineHit: 0,
    unbounded: { predicted: 0, observed: 0, hit: 0 },
    textLines: 0,
    missed: [],
    edges: 0,
    edgesMapped: 0,
    ms: 0,
  };
  const done = (r: Partial<CommitResult>): CommitResult => ({ ...base, ...r, ms: Date.now() - t0 });

  const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', `${sha}^`, sha]);
  const oldSide = new Map<string, LineRange[]>();
  for (const [f, r] of parseUnifiedDiff(diff, 'old')) if (inScope(f)) oldSide.set(f, r);
  if (!oldSide.size) return done({ status: 'not-qualifying', reason: 'no in-scope TypeScript' });

  // The parent's code, its dependencies, a fresh index with today's rig.
  git(['checkout', '-q', '--detach', '--force', `${sha}^`], wt);
  sh('git', ['clean', '-fdq', '-e', 'node_modules'], wt);
  const install = sh('bun', ['install', '--frozen-lockfile'], wt);
  if (install.status !== 0) {
    const retry = sh('bun', ['install'], wt);
    if (retry.status !== 0) return done({ reason: 'install failed' });
  }
  // The embedded grammars are generated, not committed; without them every
  // test that loads the extractor fails and the oracle quietly shrinks.
  const pkg = JSON.parse(readFileSync(join(wt, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  if (pkg.scripts?.['gen:wasm']) {
    const gen = sh('bun', ['run', 'gen:wasm'], wt);
    if (gen.status !== 0) return done({ reason: 'gen:wasm failed' });
  }
  rmSync(join(wt, '.rig'), { recursive: true, force: true });
  const rig = await Rig.init(wt, { embedder: new DeterministicEmbedder() });
  try {
    await rig.indexAll();
    const db = rig.database.adapter;

    // Changed symbols: the parent's innermost symbols under the removed or
    // modified lines; qualifying needs at least one function or method.
    const changedIds = new Set<string>();
    let fnOrMethod = false;
    for (const [file, ranges] of oldSide) {
      const syms = symbolsInFile(db, file);
      for (const range of ranges)
        for (const n of innermostSymbols(syms, range)) {
          if (n.type === 'markdown-section') continue;
          changedIds.add(n.id);
          if (n.type === 'function' || n.type === 'method') fnOrMethod = true;
        }
    }
    if (!fnOrMethod)
      return done({ status: 'not-qualifying', reason: 'no function or method changed' });

    // Prediction (depth 2 and unbounded), test symbols removed.
    const predict = (depth: number) => {
      const r = diffImpact(db, oldSide, [], { depth });
      return {
        r,
        ids: new Set(r.dependents.filter((d) => !isTestPath(d.filePath)).map((d) => d.id)),
      };
    };
    const p2 = predict(2);
    const pAll = predict(50);
    const textLines = renderImpactText(p2.r).trimEnd().split('\n').length;

    // Baseline: symbols in files that import a changed file, directly or
    // through one more importing file.
    const fileOf = new Map<string, string>(); // file node id -> path
    const fileIdOf = new Map<string, string>();
    for (const r of db
      .prepare(`SELECT id, json_extract(data, '$.filePath') AS p FROM nodes WHERE type = 'file'`)
      .all() as { id: string; p: string }[]) {
      fileOf.set(r.id, r.p);
      fileIdOf.set(r.p, r.id);
    }
    const importers = new Map<string, Set<string>>();
    for (const e of db.prepare(`SELECT src, dst FROM edges WHERE kind = 'imports'`).all() as {
      src: string;
      dst: string;
    }[]) {
      if (!importers.has(e.dst)) importers.set(e.dst, new Set());
      importers.get(e.dst)!.add(e.src);
    }
    const changedFiles = new Set(
      [...oldSide.keys()].map((f) => fileIdOf.get(f)).filter((x): x is string => !!x),
    );
    const importingFiles = reverseReach(changedFiles, importers, 2);
    const baselineIds = new Set<string>();
    for (const fid of importingFiles) {
      const path = fileOf.get(fid);
      if (!path || isTestPath(path)) continue;
      for (const s of symbolsInFile(db, path))
        if (s.type !== 'markdown-section') baselineIds.add(s.id);
    }

    // Oracle: the parent's suite under the recorder.
    const callsOut = join(WORK, `calls-${sha.slice(0, 7)}.jsonl`);
    rmSync(callsOut, { force: true });
    const run = spawnSync('bun', ['test', '--preload', RECORDER], {
      cwd: wt,
      encoding: 'utf-8',
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, RIG_EVAL_ROOT: wt, RIG_CALLS_OUT: callsOut, RIG_NO_WATCH: '1' },
    });
    if (!existsSync(callsOut)) return done({ reason: `suite did not run (exit ${run.status})` });
    const lines = readFileSync(callsOut, 'utf-8').split('\n').filter(Boolean);
    if (!lines.length) return done({ reason: 'no call edges recorded' });

    const symCache = new Map<string, ReturnType<typeof symbolsInFile>>();
    const symAt = (abs: string, line: number): string | null => {
      const rel = relative(wt, abs).split(sep).join('/');
      if (rel.startsWith('..')) return null;
      let syms = symCache.get(rel);
      if (!syms) symCache.set(rel, (syms = symbolsInFile(db, rel)));
      return innermostSymbolAt(syms, line)?.id ?? null;
    };
    const calledBy = new Map<string, Set<string>>(); // callee -> callers
    const executed = new Set<string>();
    let mapped = 0;
    for (const l of lines) {
      const e = JSON.parse(l) as {
        callerFile: string;
        callerLine: number;
        calleeFile: string;
        calleeLine: number;
      };
      const callee = symAt(e.calleeFile, e.calleeLine);
      if (callee) executed.add(callee);
      const caller = symAt(e.callerFile, e.callerLine);
      if (callee && caller) mapped++;
      if (!callee || !caller || caller === callee) continue;
      if (!calledBy.has(callee)) calledBy.set(callee, new Set());
      calledBy.get(callee)!.add(caller);
    }
    const changedExecuted = [...changedIds].filter((id) => executed.has(id)).length;
    const diag = { edges: lines.length, edgesMapped: mapped };
    if (!changedExecuted)
      return done({
        ...diag,
        status: 'not-executed',
        changed: changedIds.size,
        reason: 'changed symbols never executed',
      });

    const testIds = new Set(
      (
        db.prepare(`SELECT id, json_extract(data, '$.filePath') AS p FROM nodes`).all() as {
          id: string;
          p: string | null;
        }[]
      )
        .filter((r) => isTestPath(r.p))
        .map((r) => r.id),
    );
    const observed = (depth: number) =>
      new Set([...reverseReach(changedIds, calledBy, depth)].filter((id) => !testIds.has(id)));
    const o2 = observed(2);
    const oAll = observed(50);
    const inter = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));
    const nameOf = (id: string) =>
      (db.prepare('SELECT name FROM nodes WHERE id = ?').get(id) as { name: string } | undefined)
        ?.name ?? id;

    return done({
      ...diag,
      status: 'scored',
      changed: changedIds.size,
      changedExecuted,
      predicted: p2.ids.size,
      observed: o2.size,
      hit: inter(p2.ids, o2).length,
      baselinePredicted: baselineIds.size,
      baselineHit: inter(baselineIds, o2).length,
      unbounded: {
        predicted: pAll.ids.size,
        observed: oAll.size,
        hit: inter(pAll.ids, oAll).length,
      },
      textLines,
      missed: [...o2].filter((id) => !p2.ids.has(id)).map(nameOf),
    });
  } finally {
    rig.close();
  }
};

const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');

const main = async (): Promise<void> => {
  mkdirSync(WORK, { recursive: true });
  const wt = join(WORK, 'wt');
  if (!existsSync(wt)) git(['worktree', 'add', '-q', '--detach', wt, FROM]);
  const commits = git(['rev-list', '--no-merges', FROM]).trim().split('\n');
  const results: CommitResult[] = [];
  let qualifying = 0;
  for (const sha of commits) {
    if (qualifying >= TAKE) break;
    let r: CommitResult;
    try {
      r = await replayCommit(sha, wt);
    } catch (e) {
      r = {
        commit: sha.slice(0, 7),
        subject: '',
        status: 'skipped',
        reason: String(e).slice(0, 200),
        changed: 0,
        changedExecuted: 0,
        predicted: 0,
        observed: 0,
        hit: 0,
        baselinePredicted: 0,
        baselineHit: 0,
        unbounded: { predicted: 0, observed: 0, hit: 0 },
        textLines: 0,
        missed: [],
        edges: 0,
        edgesMapped: 0,
        ms: 0,
      };
    }
    if (r.status !== 'not-qualifying') qualifying++;
    results.push(r);
    console.log(
      `${r.commit} ${r.status.padEnd(14)} ${r.reason ?? ''} edges mapped ${r.edgesMapped}/${r.edges}  (${Math.round(r.ms / 1000)} s)`,
    );
  }

  const scored = results.filter((r) => r.status === 'scored');
  const sum = (f: (r: CommitResult) => number) => scored.reduce((a, r) => a + f(r), 0);
  const recall = sum((r) => r.hit) / sum((r) => r.observed);
  const precision = sum((r) => r.hit) / sum((r) => r.predicted);
  const bRecall = sum((r) => r.baselineHit) / sum((r) => r.observed);
  const bPrecision = sum((r) => r.baselineHit) / sum((r) => r.baselinePredicted);
  const missShare = scored.filter((r) => r.hit < r.observed).length / scored.length;
  const sortedLines = scored.map((r) => r.textLines).sort((a, b) => a - b);
  const medianLines = sortedLines.length
    ? sortedLines[Math.floor((sortedLines.length - 1) / 2)]!
    : 0;

  const enough = scored.length >= MIN_SCORED;
  const primary = recall >= 0.8;
  const baseline = precision - bPrecision >= 0.1 && recall >= bRecall;
  const verdict = !enough ? 'INCONCLUSIVE' : primary && baseline ? 'PASS' : 'FAIL';

  const summary = {
    verdict,
    from: FROM,
    scored: scored.length,
    examined: results.length,
    notExecuted: results.filter((r) => r.status === 'not-executed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    recall,
    precision,
    baseline: { recall: bRecall, precision: bPrecision },
    unflaggedMissShare: missShare,
    medianTextLines: medianLines,
    unbounded: {
      recall: sum((r) => r.unbounded.hit) / sum((r) => r.unbounded.observed),
      precision: sum((r) => r.unbounded.hit) / sum((r) => r.unbounded.predicted),
    },
  };
  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(import.meta.dir, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${date}-impact-eval.json`),
    JSON.stringify({ summary, results }, null, 2) + '\n',
  );
  const md = [
    `# Impact evaluation — ${verdict}`,
    '',
    `Pre-registered in \`scripts/impact-eval/README.md\`. Commits from \`${FROM}\`: ${results.length} examined, ${scored.length} scored, ${summary.notExecuted} with changed symbols the suite never runs, ${summary.skipped} skipped.`,
    '',
    '| measure | rig (depth 2) | file-level baseline | bar |',
    '|---|---:|---:|---:|',
    `| micro recall | ${pct(
      sum((r) => r.hit),
      sum((r) => r.observed),
    )} | ${pct(
      sum((r) => r.baselineHit),
      sum((r) => r.observed),
    )} | rig ≥ 80% |`,
    `| micro precision | ${pct(
      sum((r) => r.hit),
      sum((r) => r.predicted),
    )} | ${pct(
      sum((r) => r.baselineHit),
      sum((r) => r.baselinePredicted),
    )} | rig ≥ baseline + 10 pp |`,
    `| commits with an unflagged miss | ${pct(scored.filter((r) => r.hit < r.observed).length, scored.length)} | | ≤ 20% |`,
    `| median \`rig impact\` text lines | ${medianLines} | | ≤ 25 |`,
    '',
    `Unbounded depth: recall ${pct(
      sum((r) => r.unbounded.hit),
      sum((r) => r.unbounded.observed),
    )}, precision ${pct(
      sum((r) => r.unbounded.hit),
      sum((r) => r.unbounded.predicted),
    )}.`,
    '',
    '| commit | status | changed (executed) | predicted | observed | hit | baseline P / hit | missed |',
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...results
      .filter((r) => r.status !== 'not-qualifying')
      .map(
        (r) =>
          `| \`${r.commit}\` ${r.subject.replace(/\|/g, '\\|').slice(0, 60)} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${r.changed} (${r.changedExecuted}) | ${r.predicted} | ${r.observed} | ${r.hit} | ${r.baselinePredicted} / ${r.baselineHit} | ${r.missed.slice(0, 5).join(', ')} |`,
      ),
  ].join('\n');
  writeFileSync(join(outDir, `${date}-impact-eval.md`), md + '\n');
  console.log(JSON.stringify(summary, null, 2));
};

await main();
