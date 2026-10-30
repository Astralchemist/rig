// SPDX-License-Identifier: Apache-2.0
// The pre-registered staleness evaluation (README.md): does verify-on-read
// tell the truth about memory after the code moves on?
//
//   bun run scripts/staleness-eval/replay.ts [--from fd36ac5] [--take 80] [--work <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../../packages/core/src/embed/deterministic-embedder.ts';
import { detectLanguage, getParser } from '../../packages/core/src/extract/grammars.ts';

const REPO = resolve(import.meta.dir, '../..');
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const FROM = arg('--from', 'fd36ac5');
const TAKE = Number(arg('--take', '80'));
const PER_COMMIT = 40;
const MIN_ANCHORS = 1000;
const WORK_ARG = resolve(arg('--work', join(tmpdir(), 'rig-staleness-eval')));
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

// Ground truth: tree-sitter leaf tokens, comments excluded.
type TSNode = { type: string; text: string; childCount: number; children: TSNode[] };
const parsers = new Map<string, NonNullable<Awaited<ReturnType<typeof getParser>>>>();
const tokens = (path: string, text: string): string[] => {
  const p = parsers.get(detectLanguage(path));
  if (!p) return text.split(/\s+/).filter(Boolean);
  const tree = p.parse(text);
  const out: string[] = [];
  const walk = (n: TSNode): void => {
    if (n.type === 'comment') return;
    if (n.childCount === 0) {
      if (n.text.trim()) out.push(n.text);
      return;
    }
    for (const c of n.children) walk(c);
  };
  if (tree) walk(tree.rootNode as unknown as TSNode);
  tree?.delete?.();
  return out;
};

interface Sym {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
}
const symbols = (rig: Rig, files: readonly string[] | null): Sym[] => {
  const rows = rig.database.adapter
    .prepare(`SELECT id, name, data FROM nodes WHERE type IN ('function', 'method')`)
    .all() as { id: string; name: string; data: string }[];
  const want = files ? new Set(files) : null;
  const out: Sym[] = [];
  for (const r of rows) {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    if (typeof d.filePath !== 'string' || typeof d.startLine !== 'number') continue;
    if (want && !want.has(d.filePath)) continue;
    out.push({
      id: r.id,
      name: r.name,
      qualifiedName: typeof d.qualifiedName === 'string' ? d.qualifiedName : r.name,
      filePath: d.filePath,
      startLine: d.startLine,
      endLine: typeof d.endLine === 'number' ? d.endLine : d.startLine,
    });
  }
  return out.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
};
const textOf = (wt: string, s: Sym): string | null => {
  const f = join(wt, s.filePath);
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf-8')
    .split('\n')
    .slice(s.startLine - 1, s.endLine)
    .join('\n');
};

type Truth = 'unchanged' | 'cosmetic' | 'modified' | 'renamed' | 'deleted';
interface AnchorResult {
  commit: string;
  symbol: string;
  file: string;
  truth: Truth;
  status: string;
}

const replayCommit = async (sha: string, wt: string): Promise<AnchorResult[] | null> => {
  const touched = git(['diff', '--name-status', `${sha}^`, sha])
    .trim()
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([st, p]) => p && /^[MD]/.test(st!) && inScope(p))
    .map(([, p]) => p!);
  if (!touched.length) return null;

  git(['checkout', '-q', '--detach', '--force', `${sha}^`], wt);
  git(['clean', '-fdq', '-e', 'node_modules'], wt);
  rmSync(join(wt, '.rig'), { recursive: true, force: true });
  const rig = await Rig.init(wt, { embedder: new DeterministicEmbedder() });
  try {
    await rig.indexAll();
    const anchors = symbols(rig, touched).slice(0, PER_COMMIT);
    if (!anchors.length) return null;
    const before = new Map<string, { text: string; toks: string[] }>();
    for (const a of anchors) {
      const text = textOf(wt, a) ?? '';
      before.set(a.id, { text, toks: tokens(a.filePath, text) });
      rig.writes.dropWaypoint(
        {
          kind: 'decision',
          title: a.id,
          summary: `about ${a.qualifiedName}`,
          constellationRefs: [a.id],
          keyTerms: [],
          rationale: 'staleness eval',
        },
        { sessionId: 'staleness-eval', actor: 'ai:eval' },
      );
    }

    git(['checkout', '-q', '--detach', '--force', sha], wt);
    await rig.sync();
    const verified = new Map(
      rig
        .verifyWaypoints(rig.getWaypoints({ limit: 100_000 }))
        .map((w) => [w.title, w.verification.status] as const),
    );

    const after = symbols(rig, null);
    const changedFiles = new Set(
      git(['diff', '--name-only', `${sha}^`, sha])
        .trim()
        .split('\n')
        .filter((p) => /\.(ts|tsx)$/.test(p)),
    );
    const candidates = after.filter((s) => changedFiles.has(s.filePath));
    const out: AnchorResult[] = [];
    for (const a of anchors) {
      const was = before.get(a.id)!;
      const same = after.find(
        (s) => s.filePath === a.filePath && s.qualifiedName === a.qualifiedName,
      );
      let truth: Truth;
      if (same) {
        const now = textOf(wt, same) ?? '';
        truth =
          now === was.text
            ? 'unchanged'
            : tokens(same.filePath, now).join('\u0000') === was.toks.join('\u0000')
              ? 'cosmetic'
              : 'modified';
      } else {
        const anon = (toks: string[], name: string) =>
          toks.map((t) => (t === name ? '<name>' : t)).join('\u0000');
        const target = anon(was.toks, a.name);
        const moved = candidates.some((c) => {
          const t = textOf(wt, c);
          return t !== null && anon(tokens(c.filePath, t), c.name) === target;
        });
        truth = moved ? 'renamed' : 'deleted';
      }
      out.push({
        commit: sha.slice(0, 7),
        symbol: a.qualifiedName,
        file: a.filePath,
        truth,
        status: verified.get(a.id) ?? 'absent',
      });
    }
    return out;
  } finally {
    rig.close();
  }
};

const main = async (): Promise<void> => {
  for (const l of ['typescript', 'tsx'] as const) {
    const p = await getParser(l);
    if (p) parsers.set(l, p);
  }
  const wt = join(WORK, 'wt');
  if (!existsSync(wt)) git(['worktree', 'add', '-q', '--detach', wt, FROM]);
  const commits = git(['rev-list', '--no-merges', FROM]).trim().split('\n');
  const all: AnchorResult[] = [];
  const skipped: { commit: string; reason: string }[] = [];
  let taken = 0;
  for (const sha of commits) {
    if (taken >= TAKE) break;
    try {
      const r = await replayCommit(sha, wt);
      if (!r) continue;
      taken++;
      all.push(...r);
      console.log(`${sha.slice(0, 7)} ${r.length} anchors`);
    } catch (e) {
      taken++;
      skipped.push({ commit: sha.slice(0, 7), reason: String(e).slice(0, 200) });
      console.log(`${sha.slice(0, 7)} skipped`);
    }
  }

  const count = (truths: Truth[], ok: (s: string) => boolean) => {
    const set = all.filter((r) => truths.includes(r.truth));
    return { n: set.length, hit: set.filter((r) => ok(r.status)).length };
  };
  const stale = count(['modified'], (s) => s === 'verified');
  const falseInv = count(['unchanged', 'cosmetic'], (s) => s !== 'verified');
  const deleted = count(['deleted'], (s) => s === 'missing' || s === 'changed');
  const renamed = count(['renamed'], (s) => s === 'verified');
  const rate = (c: { n: number; hit: number }) => (c.n ? c.hit / c.n : null);
  const enough = all.length >= MIN_ANCHORS;
  const bars = {
    staleServed: (rate(stale) ?? 0) <= 0.02,
    falseInvalidation: (rate(falseInv) ?? 0) <= 0.05,
    deletedFlagged: (rate(deleted) ?? 1) >= 0.95,
  };
  const verdict = !enough ? 'INCONCLUSIVE' : Object.values(bars).every(Boolean) ? 'PASS' : 'FAIL';
  const byTruth = Object.fromEntries(
    (['unchanged', 'cosmetic', 'modified', 'renamed', 'deleted'] as Truth[]).map((t) => {
      const rows = all.filter((r) => r.truth === t);
      const st: Record<string, number> = {};
      for (const r of rows) st[r.status] = (st[r.status] ?? 0) + 1;
      return [t, st];
    }),
  );
  const summary = {
    verdict,
    from: FROM,
    commits: taken,
    anchors: all.length,
    skipped: skipped.length,
    stale,
    falseInv,
    deleted,
    renamed,
    bars,
    byTruth,
  };
  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(import.meta.dir, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${date}-staleness.json`),
    JSON.stringify({ summary, skipped, anchors: all }, null, 2) + '\n',
  );
  const pct = (c: { n: number; hit: number }) =>
    c.n ? `${((100 * c.hit) / c.n).toFixed(1)}% (${c.hit}/${c.n})` : '–';
  const md = [
    `# Staleness evaluation — ${verdict}`,
    '',
    `Pre-registered in \`scripts/staleness-eval/README.md\`. ${taken} commits from \`${FROM}\`, ${all.length} anchors, ${skipped.length} commits skipped.`,
    '',
    '| measure | result | bar |',
    '|---|---:|---:|',
    `| stale served (modified reported verified) | ${pct(stale)} | ≤ 2% |`,
    `| false invalidation (unchanged or cosmetic not verified) | ${pct(falseInv)} | ≤ 5% |`,
    `| deleted flagged (missing or changed) | ${pct(deleted)} | ≥ 95% |`,
    `| renames followed (reported verified) | ${pct(renamed)} | none (known gap) |`,
    '',
    '| truth | statuses |',
    '|---|---|',
    ...Object.entries(byTruth).map(
      ([t, st]) =>
        `| ${t} | ${
          Object.entries(st)
            .map(([s, n]) => `${s} ${n}`)
            .join(', ') || '–'
        } |`,
    ),
  ].join('\n');
  writeFileSync(join(outDir, `${date}-staleness.md`), md + '\n');
  console.log(md);
};

await main();
