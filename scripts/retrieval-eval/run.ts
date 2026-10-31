// SPDX-License-Identifier: Apache-2.0
// The pre-registered retrieval evaluation (README.md): commit subjects as
// queries, the files each commit changed as the answer, keyword vs hybrid.
//
//   bun run scripts/retrieval-eval/run.ts [--from fd36ac5] [--take 100] [--work <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../../packages/core/src/index.ts';

const REPO = resolve(import.meta.dir, '../..');
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const FROM = arg('--from', 'fd36ac5');
const TAKE = Number(arg('--take', '100'));
const WORK_ARG = resolve(arg('--work', join(tmpdir(), 'rig-retrieval-eval')));
mkdirSync(WORK_ARG, { recursive: true });
const WORK = realpathSync(WORK_ARG);

const git = (args: string[], cwd = REPO): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const inScope = (p: string): boolean =>
  p.startsWith('packages/') &&
  /\.(ts|tsx)$/.test(p) &&
  !/(^|\/)__tests__\//.test(p) &&
  !/\.test\.tsx?$/.test(p);
const CODE_KINDS = new Set([
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'variable',
  'constant',
  'file',
]);
const SKIP = /^(docs|chore|test|ci|release|style|Merge)\b/i;

interface Query {
  commit: string;
  query: string;
  files: string[];
  keyword: string[];
  hybrid: string[];
}

const rankOf = (results: string[], files: Set<string>): number => {
  const i = results.findIndex((f) => files.has(f));
  return i < 0 ? Infinity : i + 1;
};

const main = async (): Promise<void> => {
  const wt = join(WORK, 'wt');
  if (!existsSync(wt)) git(['worktree', 'add', '-q', '--detach', wt, FROM]);
  const existing = new Set(git(['ls-tree', '-r', '--name-only', FROM]).trim().split('\n'));

  // Population first, from git alone.
  const picked: { sha: string; query: string; files: string[] }[] = [];
  for (const sha of git(['rev-list', '--no-merges', FROM]).trim().split('\n')) {
    if (picked.length >= TAKE) break;
    const subject = git(['log', '-1', '--format=%s', sha]).trim();
    if (SKIP.test(subject)) continue;
    const files = git(['diff', '--name-only', `${sha}^`, sha])
      .trim()
      .split('\n')
      .filter((f) => inScope(f) && existing.has(f));
    if (files.length < 1 || files.length > 8) continue;
    const query = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').trim();
    if (query) picked.push({ sha: sha.slice(0, 7), query, files });
  }

  const rig = await Rig.init(wt, {});
  try {
    await rig.indexAll();
    rig.warmSearch();
    const queries: Query[] = [];
    for (const p of picked) {
      const code = <T extends { type: string; data: unknown }>(nodes: T[]): string[] =>
        nodes
          .filter((n) => CODE_KINDS.has(n.type))
          .map((n) => (n.data as { filePath?: string }).filePath ?? '')
          .slice(0, 10);
      const keyword = code(rig.searchNodes(p.query, { limit: 20 }));
      const h = await rig.search(p.query, { limit: 20, waitMs: 120_000 });
      const hybrid = code(h.hits.map((x) => x.node));
      queries.push({ commit: p.sha, query: p.query, files: p.files, keyword, hybrid });
      console.log(
        `${p.sha} kw@${rankOf(keyword, new Set(p.files))} hy@${rankOf(hybrid, new Set(p.files))}  ${p.query.slice(0, 60)}`,
      );
    }

    const score = (arm: 'keyword' | 'hybrid') => {
      const ranks = queries.map((q) => rankOf(q[arm], new Set(q.files)));
      return {
        acc1: ranks.filter((r) => r <= 1).length / ranks.length,
        acc5: ranks.filter((r) => r <= 5).length / ranks.length,
        mrr10: ranks.reduce((a, r) => a + (r <= 10 ? 1 / r : 0), 0) / ranks.length,
      };
    };
    const kw = score('keyword');
    const hy = score('hybrid');
    const verdict =
      queries.length < TAKE ? 'INCONCLUSIVE' : hy.acc5 - kw.acc5 >= 0.05 ? 'PASS' : 'FAIL';
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    const summary = { verdict, from: FROM, queries: queries.length, keyword: kw, hybrid: hy };
    const date = new Date().toISOString().slice(0, 10);
    const out = resolve(import.meta.dir, 'results');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, `${date}-retrieval.json`),
      JSON.stringify({ summary, queries }, null, 2) + '\n',
    );
    const md = [
      `# Retrieval evaluation — ${verdict}`,
      '',
      `Pre-registered in \`scripts/retrieval-eval/README.md\`. ${queries.length} commit subjects from \`${FROM}\` as queries; the answer is the files each commit changed.`,
      '',
      '| arm | acc@1 | acc@5 | MRR@10 |',
      '|---|---:|---:|---:|',
      `| keyword | ${pct(kw.acc1)} | ${pct(kw.acc5)} | ${kw.mrr10.toFixed(3)} |`,
      `| hybrid | ${pct(hy.acc1)} | ${pct(hy.acc5)} | ${hy.mrr10.toFixed(3)} |`,
      '',
      `Bar: hybrid acc@5 at least 5 pp above keyword. Difference: ${((hy.acc5 - kw.acc5) * 100).toFixed(1)} pp.`,
    ].join('\n');
    writeFileSync(join(out, `${date}-retrieval.md`), md + '\n');
    console.log(md);
  } finally {
    rig.close();
  }
};

await main();
