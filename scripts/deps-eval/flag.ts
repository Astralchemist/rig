// SPDX-License-Identifier: Apache-2.0
// Index each pinned repo, list what rig_unused_deps flags, and collect the
// evidence a labeller needs (README.md has the pre-registration and rules).
//
//   bun run scripts/deps-eval/flag.ts
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Rig } from '../../packages/core/src/index.ts';
import { DeterministicEmbedder } from '../../packages/core/src/embed/deterministic-embedder.ts';

const CORPUS_DIR = join(homedir(), 'Development/rig-wt/deps-corpus');
const REPOS = [
  { name: 'rig', git: resolve(import.meta.dir, '../..'), commit: 'f12631f' },
  {
    name: 'next-auth',
    git: join(homedir(), 'Development/rig-bench/next-auth'),
    commit: 'e293b3746616660f0844347a68d09eac54b95c6f',
  },
  {
    name: 'hono',
    git: join(CORPUS_DIR, 'hono'),
    commit: '17ad0e21f5a91c939eeafa3df05793a8ea60f016',
  },
  {
    name: 'fastapi',
    git: join(CORPUS_DIR, 'fastapi'),
    commit: '79cab5bed28b24d92c185d236feb33f5783dfeb3',
  },
  {
    name: 'httpx',
    git: join(CORPUS_DIR, 'httpx'),
    commit: 'b5addb64f0161ff6bfe94c124ef76f6a1fba5254',
  },
];
// v2 (README): a held-out corpus, pinned before the repair was written.
const HELDOUT = [
  { name: 'zustand', git: join(CORPUS_DIR, 'zustand'), commit: '382d29c485e67018c06e75ec7235130d0968522c' },
  { name: 'trpc', git: join(CORPUS_DIR, 'trpc'), commit: '708753ff1383c47c5f765694978db1000a86ee36' },
  { name: 'flask', git: join(CORPUS_DIR, 'flask'), commit: '49943b5a94413a530761350f04e896f76e8d620e' },
  { name: 'starlette', git: join(CORPUS_DIR, 'starlette'), commit: '2745bbc5afa2f8ce900d290bedca2bc5d3f3cfe8' },
];
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const SET = arg('--set', 'v1') === 'heldout' ? HELDOUT : REPOS;
const OUT = arg('--out', 'flags.json');
const SAMPLE_MAX = 40;
const EVIDENCE_MAX = 25;

let seed = 20261031;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sample = <T>(xs: T[], n: number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
};

const SKIP =
  /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock|CHANGELOG[^/]*|HISTORY[^/]*|release-notes[^/]*)$/i;

const binsOf = async (name: string): Promise<string[]> => {
  try {
    const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
    if (!r.ok) return [];
    const bin = ((await r.json()) as { bin?: string | Record<string, string> }).bin;
    if (!bin) return [];
    return typeof bin === 'string' ? [name.split('/').pop()!] : Object.keys(bin);
  } catch {
    return [];
  }
};

// Names to look for: the package, its import spellings, its commands.
const termsOf = (name: string, source: string, bins: string[]): string[] => {
  const t = new Set([name, ...bins]);
  if (source === 'pypi') {
    t.add(name.toLowerCase());
    t.add(name.toLowerCase().replace(/[-.]/g, '_'));
  }
  if (name.startsWith('@types/')) {
    const x = name.slice(7);
    t.add(x.includes('__') ? `@${x.replace('__', '/')}` : x);
  }
  return [...t].filter((s) => s.length > 1);
};

// Lines of a manifest that only declare dependencies are not evidence.
const isDeclLine = (file: string, text: string, name: string): boolean => {
  if (/package\.json$/.test(file))
    return new RegExp(`^\\s*"${name.replace(/[/@.]/g, '\\$&')}"\\s*:`).test(text);
  if (/(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg)$/.test(file))
    return new RegExp(`^\\s*["']?${name.replace(/[.]/g, '\\.')}\\s*([<>=!~\\[;,"']|$)`, 'i').test(
      text,
    );
  return false;
};

const evidenceFor = (root: string, files: string[], terms: string[], name: string) => {
  const out: { file: string; line: number; text: string }[] = [];
  const res = terms.map(
    (t) =>
      new RegExp(`(^|[^A-Za-z0-9_-])${t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^A-Za-z0-9_])`),
  );
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(root, f), 'utf-8');
    } catch {
      continue;
    }
    if (src.length > 2_000_000) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      if (!res.some((r) => r.test(text))) continue;
      if (isDeclLine(f, text, name)) continue;
      out.push({ file: f, line: i + 1, text: text.trim().slice(0, 200) });
      if (out.length >= EVIDENCE_MAX) return out;
    }
  }
  return out;
};

const main = async (): Promise<void> => {
  const all: unknown[] = [];
  const counts: Record<string, { flagged: number; labelled: number; declared: number }> = {};
  for (const repo of SET) {
    const dir = mkdtempSync(join(tmpdir(), `deps-eval-${repo.name}-`));
    execSync(`git -C "${repo.git}" archive ${repo.commit} | tar -x -C "${dir}"`, { stdio: 'pipe' });
    const files = execSync(`git -C "${repo.git}" ls-tree -r --name-only ${repo.commit}`, {
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((f) => f && !SKIP.test(f));
    const rig = await Rig.init(dir, { embedder: new DeterministicEmbedder() });
    let flagged, declared;
    try {
      await rig.indexAll();
      flagged = rig.getUnusedDependencies();
      declared = rig.getDependencies().length;
    } finally {
      rig.close();
    }
    const picked = flagged.length > SAMPLE_MAX ? sample(flagged, SAMPLE_MAX) : flagged;
    counts[repo.name] = { flagged: flagged.length, labelled: picked.length, declared };
    for (const d of picked) {
      const bins = d.source === 'npm' ? await binsOf(d.name) : [];
      all.push({
        key: `${repo.name}:${d.manifest_path}:${d.name}`,
        repo: repo.name,
        name: d.name,
        source: d.source,
        manifest: d.manifest_path,
        spec: d.spec,
        is_dev: d.is_dev,
        bins,
        evidence: evidenceFor(dir, files, termsOf(d.name, d.source, bins), d.name),
      });
    }
    rmSync(dir, { recursive: true, force: true });
    console.log(
      `${repo.name}: ${declared} declared, ${flagged.length} flagged, ${picked.length} to label`,
    );
  }
  const out = resolve(import.meta.dir, 'results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, OUT), JSON.stringify({ counts, flags: all }, null, 2) + '\n');
};

await main();
