// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SqliteAdapter } from './db/adapter.ts';
import { EXTRACTED_NODE_SQL } from './db/extracted-nodes.ts';
import { getMeta, setMeta } from './db/meta.ts';
import { listWaypoints } from './db/waypoint-queries.ts';
import { EXTRACTOR_VERSION } from './extract/extractor.ts';

// The orientation map: a compact, deterministic markdown overview of the
// repository that an agent reads once at the start of a session instead of
// spending turns exploring its shape (Aider's repo map is the precedent).
// Built only from the indexed graph and the indexed files (manifests,
// READMEs, module docstrings); no model calls.
//
// Sections, each ranked by importance and trimmed to fit the budget:
//   basics       name, languages, workspace, key runtime dependencies
//   entry points manifest exports / main / bin mapped to source, index files
//   layout       packages (sibling families folded) and top directories
//   key symbols  hub files and the most-referenced exported symbols
//   surfaces     closed name sets (string-literal unions, enums), handler
//                directories, the functions that dispatch to them, HTTP verbs
//   tests        where tests live and which sources they import
//   decisions    recent decision waypoint titles
//
// The map is cached in meta under a fingerprint of everything it reads (the
// files table, the shown waypoints, the extractor and map versions), so the
// update pipeline regenerates it only when one of those changed.

// Bump when the map's content or format changes, so cached maps regenerate.
export const ORIENTATION_VERSION = 1;
// Default budget in tokens, and the chars-per-token estimate used to enforce it.
export const DEFAULT_OVERVIEW_BUDGET = 2000;
export const CHARS_PER_TOKEN = 4;
export const MIN_OVERVIEW_BUDGET = 200;
export const MAX_OVERVIEW_BUDGET = 20_000;
export const META_OVERVIEW = 'overview';

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface Overview {
  map: string;
  // When the map was generated (ms since the epoch).
  generated_at: number;
  // Nodes in the graph it was generated from.
  nodes: number;
  budget: number;
  chars: number;
  est_tokens: number;
  // Time to generate it, and whether it came from the meta cache.
  elapsed_ms: number;
  cached: boolean;
}

interface CachedOverview {
  version: number;
  fingerprint: string;
  generated_at: number;
  nodes: number;
  elapsed_ms: number;
  map: string;
}

// ---------------------------------------------------------------------------
// Inputs

interface Sym {
  id: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  sig: string | null;
  exported: boolean;
}

interface Manifest {
  dir: string; // '' for the project root
  path: string;
  name: string | null;
  description: string | null;
  json: PackageJson | null;
  pyScripts: [string, string][];
}

interface PackageJson {
  name?: unknown;
  description?: unknown;
  main?: unknown;
  module?: unknown;
  bin?: unknown;
  exports?: unknown;
  scripts?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
}

interface Pkg {
  dir: string;
  manifest: Manifest;
  files: string[];
  symbols: number;
  crossIn: number;
  score: number;
}

const DIRECT_KINDS = new Set(['contains', 'tests', 'manifest_declares']);
const SYMBOL_KINDS = new Set([
  'function',
  'class',
  'interface',
  'type_alias',
  'enum',
  'struct',
  'trait',
  'protocol',
  'component',
  'constant',
  'variable',
  'namespace',
]);
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const INDEX_STEMS = new Set(['index', '__init__', 'mod']);
const GENERIC_ROOT_NAMES = new Set(['root', 'monorepo', 'workspace', 'workspaces', 'project']);
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'e2e', 'spec', 'specs']);

const LANGUAGE_OF: Record<string, string> = {
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JSX',
  py: 'Python',
  pyi: 'Python',
  md: 'Markdown',
  mdx: 'Markdown',
  json: 'JSON',
  toml: 'TOML',
  txt: 'text',
};

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const extOf = (p: string): string => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
};
const stemOf = (p: string): string => {
  const b = basename(p);
  const i = b.indexOf('.');
  return i <= 0 ? b : b.slice(0, i);
};
const under = (dir: string, p: string): boolean => dir === '' || p.startsWith(dir + '/');
const rel = (dir: string, p: string): string => (dir === '' ? p : p.slice(dir.length + 1));
const slashed = (dir: string): string => (dir === '' ? './' : `${dir}/`);
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (n: number): string => n.toLocaleString('en-US');

// Same patterns as graph/tests-edges.ts, plus pytest's test_*.py / *_test.py
// and e2e / spec directories.
export const isTestPath = (p: string): boolean => {
  const b = basename(p);
  if (/\.(test|spec)\.[^.]+$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.py$/.test(b)) {
    return true;
  }
  return p
    .split('/')
    .slice(0, -1)
    .some((seg) => TEST_SEGMENTS.has(seg));
};

// The directory a test file belongs to: its test/tests/__tests__ ancestor, or
// its own directory for a co-located *.test.* file.
const testRootOf = (p: string): string => {
  const segs = p.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (TEST_SEGMENTS.has(segs[i]!)) return segs.slice(0, i + 1).join('/');
  }
  return dirOf(p);
};

// ---------------------------------------------------------------------------
// Text helpers

// One line of prose from markdown / a docstring: links and tags reduced to
// their text, whitespace collapsed, cut to the first sentence and `max` chars.
export const cleanProse = (raw: string, max = 110): string => {
  let s = raw
    .replace(/\{@link\s+(\S+?)(?:\s+([^}]+))?\}/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[_*]+(?=\S)|(?<=\S)[_*]+(?=[\s).,;:!?]|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const stop = s.search(/[.!?](\s|$)/);
  if (stop > 0 && stop < max) s = s.slice(0, stop + 1);
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    s = (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
  }
  return s;
};

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

// The first prose paragraph of a README (badges, images, HTML and code
// skipped), else its first heading.
export const readmePurpose = (text: string): string | null => {
  let inCode = false;
  let title: string | null = null;
  let para: string[] = [];
  const short: string[] = [];
  // HTML block tags end a paragraph like a blank line does.
  const lines = text
    .slice(0, 8000)
    .replace(/<\/?(h\d|p|div|br|li|ul|ol|table|tr|td|picture|source)\b[^>]*>/gi, '\n')
    .split('\n');
  const flush = (): string | null => {
    const p = cleanProse(para.join(' '));
    para = [];
    // A sentence, not a project name or a badge row.
    if (p.length >= 16 && /\w\s+\w/.test(p)) return p;
    if (p) short.push(p);
    return null;
  };
  for (const rawLine of lines.slice(0, 160)) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || line.startsWith('<!--') || line.startsWith('|')) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const p = flush();
      if (p) return p;
      title ??= cleanProse(h[1]!) || null;
      continue;
    }
    const t = cleanProse(line.replace(/^>\s*/, ''), 400);
    if (!t || /^[-=*_\s]+$/.test(t)) {
      const p = flush();
      if (p) return p;
      continue;
    }
    para.push(t);
  }
  return flush() ?? title ?? short[0] ?? null;
};

const LICENSE_LINE =
  /^(SPDX-License-Identifier|Copyright|\(c\)|©|eslint|prettier|@ts-|@flow|tslint|jshint|global |istanbul|biome-ignore|Licensed under|License|Derived from|Source:)/i;

// The comment block or docstring opening a source file (license headers,
// directives and admonition blocks skipped), as one line of prose.
export const moduleDocstring = (source: string): string | null => {
  const lines = source.split('\n').slice(0, 80);
  let i = 0;
  const skip = (l: string): boolean =>
    l === '' ||
    l.startsWith('#!') ||
    /^['"]use (strict|client|server)['"];?$/.test(l) ||
    /^#.*coding[:=]/.test(l);
  while (i < lines.length && skip(lines[i]!.trim())) i++;
  const body: string[] = [];
  const first = lines[i]?.trim() ?? '';
  if (first.startsWith('/*')) {
    for (; i < lines.length; i++) {
      const l = lines[i]!.trim();
      body.push(l.replace(/^\/\*+!?|\*+\/$/g, '').replace(/^\*\s?/, ''));
      if (l.endsWith('*/')) break;
    }
  } else if (first.startsWith('//') || (first.startsWith('#') && !first.startsWith('#!'))) {
    const mark = first.startsWith('//') ? '//' : '#';
    for (; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (!l.startsWith(mark)) break;
      body.push(l.slice(mark.length).replace(/^[/!]?\s?/, ''));
    }
  } else if (/^[rbuRBU]?("""|''')/.test(first)) {
    const q = first.includes('"""') ? '"""' : "'''";
    const open = first.slice(first.indexOf(q) + 3);
    if (open.includes(q)) body.push(open.slice(0, open.indexOf(q)));
    else {
      body.push(open);
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.includes(q)) {
          body.push(l.slice(0, l.indexOf(q)));
          break;
        }
        body.push(l.trim());
      }
    }
  } else {
    return null;
  }
  const para: string[] = [];
  let admonition = false;
  for (const raw of body) {
    const l = raw.trim();
    if (l.startsWith(':::')) {
      admonition = !admonition && l.length > 3;
      continue;
    }
    if (admonition) continue;
    if (LICENSE_LINE.test(l) || l.startsWith('@')) {
      if (para.length) break;
      continue;
    }
    if (l === '' || l.startsWith('#') || l.startsWith('```')) {
      if (para.length) break;
      continue;
    }
    para.push(l);
  }
  const p = cleanProse(para.join(' '));
  return p.length >= 8 ? p : null;
};

// A one-line declaration head from the source line a symbol starts on:
// `export interface Session extends DefaultSession {}` → `interface Session
// extends DefaultSession`.
const declarationHead = (line: string | undefined, name: string): string | null => {
  if (!line) return null;
  const s = line
    .trim()
    .replace(/^export\s+(default\s+)?/, '')
    .replace(/^(declare|abstract)\s+/, '')
    .replace(/\s*(\{\s*\}?|=\s*\{|=|:)\s*$/, '')
    .replace(/\s+/g, ' ');
  if (!s.includes(name)) return null;
  const open = (s.match(/[<([{]/g) ?? []).length;
  const close = (s.match(/[>)\]}]/g) ?? []).length - (s.match(/=>/g) ?? []).length;
  const cut = open > close && s.includes(' =') ? s.slice(0, s.indexOf(' =')) : s;
  return clip(cut, 110);
};

const compactSignature = (sig: string): string =>
  sig
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/,?\s+\)/g, ')')
    .trim();

// ---------------------------------------------------------------------------
// Manifests

const parsePyproject = (
  text: string,
): { name: string | null; description: string | null; scripts: [string, string][] } => {
  let section = '';
  let name: string | null = null;
  let description: string | null = null;
  const scripts: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv as unknown as [string, string, string];
    if (section === 'project' || section === 'tool.poetry') {
      if (k === 'name') name ??= v;
      if (k === 'description') description ??= v;
    } else if (section === 'project.scripts' || section === 'tool.poetry.scripts') {
      scripts.push([k, v]);
    }
  }
  return { name, description, scripts };
};

// The indexed source file a manifest target was built from: `./dist/index.js`
// → `src/index.ts` when that file is indexed. Returns the package-relative
// source path, or null.
const sourceFor = (pkgDir: string, target: string, files: ReadonlySet<string>): string | null => {
  let t = target.replace(/^\.\//, '');
  if (t.includes('*')) {
    const prefix = dirOf(t.slice(0, t.indexOf('*')) + 'x');
    for (const base of [prefix, prefix.replace(/^(dist|lib|build|out|esm|cjs)(\/|$)/, '')]) {
      for (const root of ['', 'src/', 'src/lib/']) {
        const d = join(pkgDir, root + base);
        for (const f of files) if (dirOf(f) === d) return `${root}${base}/*`;
      }
    }
    return null;
  }
  const stripped = t.replace(/^(dist|lib|build|out|esm|cjs)\//, '');
  const stems = [t, stripped].map((x) => x.replace(/(\.d)?\.(m|c)?[jt]sx?$/, ''));
  for (const stem of stems) {
    for (const root of ['', 'src/', 'src/lib/']) {
      for (const ext of ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']) {
        const cand = root + stem + ext;
        if (files.has(pkgDir === '' ? cand : `${pkgDir}/${cand}`)) return cand;
      }
    }
  }
  return null;
};

// Runtime target of an exports condition object: import > default > require
// > node > types.
const exportTarget = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return exportTarget(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['import', 'default', 'require', 'node', 'browser', 'types']) {
      if (k in o) {
        const t = exportTarget(o[k]);
        if (t) return t;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Budget fitting

interface Section {
  title: string;
  lines: string[];
  // Lines kept before any other section grows, and the share of the
  // remaining budget this section claims.
  min: number;
  weight: number;
}

const MAX_LINE = 240;

// Fill sections line by line, most important first, until the budget is
// spent: every section gets its `min` lines, then the section with the least
// budget used relative to its weight takes its next line. A cut section ends
// in "…N more". The result never exceeds maxChars.
const fitSections = (header: string[], sections: Section[], maxChars: number): string => {
  const secs = sections
    .map((s) => ({ ...s, lines: s.lines.map((l) => clip(l, MAX_LINE)) }))
    .filter((s) => s.lines.length > 0);
  const take = secs.map(() => 0);
  const more = (i: number, t: number): string => `- …${secs[i]!.lines.length - t} more`;
  // prefix[i][t]: chars of the first t lines of section i, newlines included.
  const prefix = secs.map((s) => {
    const p = [0];
    for (const l of s.lines) p.push(p.at(-1)! + l.length + 1);
    return p;
  });
  // Rendered size of section i showing t lines: blank line, title, lines,
  // and the "…N more" line when cut.
  const cost = (i: number, t: number): number =>
    t === 0
      ? 0
      : 1 +
        secs[i]!.title.length +
        4 +
        prefix[i]![t]! +
        (t < secs[i]!.lines.length ? more(i, t).length + 1 : 0);
  let total = header.reduce((n, l) => n + l.length + 1, 0);
  const grow = (i: number): boolean => {
    const next = total - cost(i, take[i]!) + cost(i, take[i]! + 1);
    if (next > maxChars) return false;
    total = next;
    take[i]!++;
    return true;
  };
  for (let i = 0; i < secs.length; i++) {
    while (take[i]! < Math.min(secs[i]!.min, secs[i]!.lines.length) && grow(i));
  }
  const open = new Set(secs.map((_, i) => i).filter((i) => take[i]! < secs[i]!.lines.length));
  while (open.size > 0) {
    let best = -1;
    for (const i of open) {
      const share = prefix[i]![take[i]!]! / secs[i]!.weight;
      if (best < 0 || share < prefix[best]![take[best]!]! / secs[best]!.weight) best = i;
    }
    if (!grow(best) || take[best]! >= secs[best]!.lines.length) open.delete(best);
  }
  const out = [...header];
  secs.forEach((s, i) => {
    if (take[i] === 0) return;
    out.push('', `## ${s.title}`, ...s.lines.slice(0, take[i]));
    if (take[i]! < s.lines.length) out.push(more(i, take[i]!));
  });
  const text = out.join('\n') + '\n';
  return text.length > maxChars ? text.slice(0, Math.max(0, maxChars - 2)) + '…\n' : text;
};

// ---------------------------------------------------------------------------
// Generation

export interface BuildOverviewOptions {
  // Token budget (default DEFAULT_OVERVIEW_BUDGET).
  budget?: number;
}

export const clampBudget = (budget: number | undefined): number =>
  Math.min(
    MAX_OVERVIEW_BUDGET,
    Math.max(MIN_OVERVIEW_BUDGET, Math.round(budget ?? DEFAULT_OVERVIEW_BUDGET)),
  );

export const buildOverviewMap = (
  db: SqliteAdapter,
  projectRoot: string,
  opts: BuildOverviewOptions = {},
): string => {
  const budget = clampBudget(opts.budget);
  const textCache = new Map<string, string | null>();
  const readText = (p: string): string | null => {
    if (textCache.has(p)) return textCache.get(p)!;
    let t: string | null = null;
    try {
      t = readFileSync(join(projectRoot, p), 'utf-8');
    } catch {
      t = null;
    }
    textCache.set(p, t);
    return t;
  };
  const linesCache = new Map<string, string[] | null>();
  const sourceLines = (p: string): string[] | null => {
    if (!linesCache.has(p)) linesCache.set(p, readText(p)?.split('\n') ?? null);
    return linesCache.get(p)!;
  };

  // --- graph ----------------------------------------------------------------
  const files = (
    db.prepare(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]
  ).map((r) => r.path);
  const fileSet = new Set(files);
  const testFile = new Map(files.map((f) => [f, isTestPath(f)]));
  const isTest = (f: string): boolean => testFile.get(f) ?? isTestPath(f);

  const syms = (
    db
      .prepare(
        `SELECT n.id, n.type AS kind, n.name,
                json_extract(n.data, '$.filePath') AS file,
                COALESCE(json_extract(n.data, '$.startLine'), 0) AS line,
                COALESCE(json_extract(n.data, '$.endLine'), 0) AS endLine,
                json_extract(n.data, '$.signature') AS sig,
                json_extract(n.data, '$.isExported') AS exported,
                json_extract(n.data, '$.language') AS lang
         FROM nodes n WHERE ${EXTRACTED_NODE_SQL}`,
      )
      .all() as (Omit<Sym, 'exported'> & { exported: number | null; lang: string | null })[]
  ).map(
    (r): Sym => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      file: r.file,
      line: r.line,
      endLine: r.endLine,
      sig: r.sig,
      exported: r.exported === 1 || (r.lang === 'python' && !r.name.startsWith('_')),
    }),
  );
  const symById = new Map(syms.map((s) => [s.id, s]));

  // Distinct other, non-test files pointing at each symbol and each file
  // (tests would crown test helpers); test file → the sources it imports;
  // and each function's callees.
  const symIn = new Map<string, Set<string>>();
  const fileIn = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  const testsOf = new Map<string, Set<string>>();
  const addTo = (m: Map<string, Set<string>>, k: string, v: string): void => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(v);
  };
  for (const e of db.prepare(`SELECT src, dst, kind FROM edges WHERE provenance = 'ast'`).all() as {
    src: string;
    dst: string;
    kind: string;
  }[]) {
    const a = symById.get(e.src);
    const b = symById.get(e.dst);
    if (!a || !b) continue;
    if (e.kind === 'tests') {
      if (!isTest(b.file)) addTo(testsOf, a.file, b.file);
      continue;
    }
    if (e.kind === 'calls') addTo(callees, a.id, b.id);
    if (DIRECT_KINDS.has(e.kind) || a.file === b.file || isTest(a.file)) continue;
    addTo(fileIn, b.file, a.file);
    if (b.kind !== 'file') addTo(symIn, b.id, a.file);
  }
  const inCount = (m: Map<string, Set<string>>, k: string): number => m.get(k)?.size ?? 0;

  // --- manifests & packages ---------------------------------------------------
  const manifests: Manifest[] = [];
  for (const p of files) {
    const b = basename(p);
    if (b !== 'package.json' && b !== 'pyproject.toml') continue;
    const text = readText(p);
    if (text === null) continue;
    if (b === 'package.json') {
      let json: PackageJson | null = null;
      try {
        json = JSON.parse(text) as PackageJson;
      } catch {
        json = null;
      }
      manifests.push({
        dir: dirOf(p),
        path: p,
        name: typeof json?.name === 'string' ? json.name : null,
        description: typeof json?.description === 'string' ? json.description : null,
        json,
        pyScripts: [],
      });
    } else if (!manifests.some((m) => m.dir === dirOf(p))) {
      const py = parsePyproject(text);
      manifests.push({
        dir: dirOf(p),
        path: p,
        name: py.name,
        description: py.description,
        json: null,
        pyScripts: py.scripts,
      });
    }
  }
  const rootManifest = manifests.find((m) => m.dir === '') ?? null;
  const pkgDirs = [...new Set(manifests.map((m) => m.dir))].sort((a, b) => b.length - a.length);
  const pkgOfCache = new Map<string, string>();
  const pkgOf = (p: string): string => {
    let d = pkgOfCache.get(p);
    if (d === undefined) pkgOfCache.set(p, (d = pkgDirs.find((x) => under(x, p)) ?? ''));
    return d;
  };
  const localNames = new Set(manifests.map((m) => m.name).filter((n): n is string => !!n));

  interface Dep {
    name: string;
    spec: string;
    manifest: string;
    runtime: boolean;
  }
  const declared = (
    db
      .prepare(
        `SELECT name, json_extract(data, '$.filePath') AS manifest,
                COALESCE(json_extract(data, '$.depSpec'), '') AS spec,
                json_extract(data, '$.isDevDep') AS dev, json_extract(data, '$.isPeerDep') AS peer
         FROM nodes WHERE type = 'declared-dependency' ORDER BY manifest, name`,
      )
      .all() as { name: string; manifest: string; spec: string; dev: number; peer: number }[]
  ).map(
    (d): Dep => ({
      name: d.name,
      spec: d.spec,
      manifest: d.manifest,
      runtime: d.dev !== 1 && d.peer !== 1,
    }),
  );
  // Packages that declare each local package as a dependency.
  const dependents = new Map<string, Set<string>>();
  for (const d of declared) if (localNames.has(d.name)) addTo(dependents, d.name, d.manifest);

  const pkgs = new Map<string, Pkg>();
  for (const m of manifests) {
    pkgs.set(m.dir, { dir: m.dir, manifest: m, files: [], symbols: 0, crossIn: 0, score: 0 });
  }
  const symbolsPerFile = new Map<string, number>();
  for (const s of syms) {
    if (s.kind !== 'file') symbolsPerFile.set(s.file, (symbolsPerFile.get(s.file) ?? 0) + 1);
  }
  for (const f of files) {
    const pk = pkgs.get(pkgOf(f));
    if (!pk) continue;
    pk.files.push(f);
    if (!isTest(f)) pk.symbols += symbolsPerFile.get(f) ?? 0;
  }
  for (const [f, from] of fileIn) {
    const pk = pkgs.get(pkgOf(f));
    if (!pk) continue;
    for (const g of from) if (pkgOf(g) !== pk.dir) pk.crossIn++;
  }
  // Importance: its own symbols, references from other packages, and the
  // packages that depend on it.
  for (const pk of pkgs.values()) {
    const deps = pk.manifest.name ? (dependents.get(pk.manifest.name)?.size ?? 0) : 0;
    pk.score = pk.symbols + 3 * pk.crossIn + 25 * deps;
  }
  const subPkgs = [...pkgs.values()]
    .filter((p) => p.dir !== '')
    .sort((a, b) => b.score - a.score || byName(a.dir, b.dir));

  // Sibling families: ≥3 packages under one parent sharing a name prefix
  // (packages/adapter-*), else ≥4 under one parent (apps/examples/*). A
  // member among the five most important packages, scoring at least twice
  // its family's median, stands alone; so does every package of a family
  // left too small.
  const top5 = new Set(subPkgs.slice(0, 5).map((p) => p.dir));
  const individual = new Set<string>();
  const familyOf = new Map<string, string>();
  {
    const keyOf = (p: Pkg): string => {
      const parent = dirOf(p.dir);
      const leaf = basename(p.dir);
      const prefix = leaf.includes('-') ? leaf.slice(0, leaf.indexOf('-')) : null;
      if (
        prefix &&
        subPkgs.filter((q) => dirOf(q.dir) === parent && basename(q.dir).startsWith(prefix + '-'))
          .length >= 3
      ) {
        return `${slashed(parent)}${prefix}-*`;
      }
      return `${slashed(parent)}*`;
    };
    const groups = new Map<string, Pkg[]>();
    for (const p of subPkgs) {
      const k = keyOf(p);
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    for (const [k, all] of groups) {
      const scores = all.map((m) => m.score).sort((a, b) => a - b);
      const median = scores[Math.floor(scores.length / 2)]!;
      const standout = (m: Pkg): boolean => top5.has(m.dir) && m.score >= 2 * median && m.score > 0;
      const members = all.filter((m) => !standout(m));
      const folds = members.length >= (k.endsWith('-*') ? 3 : 4);
      for (const m of all) {
        if (folds && !standout(m)) familyOf.set(m.dir, k);
        else individual.add(m.dir);
      }
    }
  }

  const dirPurpose = (dir: string): string | null => {
    for (const name of ['README.md', 'readme.md', 'README.mdx', 'Readme.md']) {
      const p = dir === '' ? name : `${dir}/${name}`;
      if (fileSet.has(p)) {
        const t = readText(p);
        const r = t ? readmePurpose(t) : null;
        if (r) return r;
      }
    }
    for (const base of [dir, dir === '' ? 'src' : `${dir}/src`]) {
      for (const f of ['index.ts', 'index.tsx', 'index.js', 'mod.ts', '__init__.py', 'main.py']) {
        const p = base === '' ? f : `${base}/${f}`;
        if (!fileSet.has(p)) continue;
        const t = readText(p);
        const d = t ? moduleDocstring(t) : null;
        if (d) return d;
      }
    }
    return null;
  };
  const pkgPurpose = (pk: Pkg): string | null =>
    pk.manifest.description ? cleanProse(pk.manifest.description) : dirPurpose(pk.dir);

  // --- basics -------------------------------------------------------------------
  const rootName = rootManifest?.name ?? null;
  const projectName =
    rootName && !GENERIC_ROOT_NAMES.has(rootName.toLowerCase()) ? rootName : basename(projectRoot);
  const basics: string[] = [];
  const rootPurpose = rootManifest?.description
    ? cleanProse(rootManifest.description)
    : dirPurpose('');
  basics.push(`- Name: ${projectName}${rootPurpose ? ` — ${rootPurpose}` : ''}`);
  const langCounts = new Map<string, number>();
  for (const f of files) {
    const l = LANGUAGE_OF[extOf(f)] ?? (extOf(f) || 'other');
    langCounts.set(l, (langCounts.get(l) ?? 0) + 1);
  }
  basics.push(
    `- Languages (files): ${[...langCounts]
      .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
      .map(([l, n]) => `${l} ${num(n)}`)
      .join(', ')}`,
  );
  if (subPkgs.length > 0) {
    const pm = rootManifest?.json?.packageManager;
    const manager = typeof pm === 'string' ? `${pm.split('@')[0]} ` : '';
    const parents = new Map<string, number>();
    for (const p of subPkgs) {
      const top = p.dir.split('/')[0]!;
      parents.set(top, (parents.get(top) ?? 0) + 1);
    }
    basics.push(
      `- Workspace: ${manager}monorepo, ${subPkgs.length} packages (${[...parents]
        .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
        .map(([d, n]) => `${d}/ ${n}`)
        .join(', ')})`,
    );
  } else if (rootManifest) {
    basics.push(`- Manifest: ${rootManifest.path}${rootName ? ` (${rootName})` : ''}`);
  }
  // Runtime dependencies: those the root and the two most important
  // manifests declare (by name), then the most imported across the repo.
  const depsOf = (m: Manifest): Dep[] =>
    declared.filter(
      (d) =>
        d.manifest === m.path &&
        d.runtime &&
        !localNames.has(d.name) &&
        !/^(workspace|link|file|portal):/.test(d.spec),
    );
  const shownDeps = new Set<string>();
  const depOwners = [
    ...(rootManifest ? [rootManifest] : []),
    ...subPkgs.slice(0, 2).map((p) => p.manifest),
  ];
  for (const m of depOwners) {
    const ds = depsOf(m);
    if (!ds.length) continue;
    for (const d of ds) shownDeps.add(d.name);
    basics.push(
      `- Dependencies of ${m.name ?? (m.dir || projectName)} (${m.path}): ${ds
        .slice(0, 12)
        .map((d) => `${d.name} ${d.spec}`.trim())
        .join(', ')}${ds.length > 12 ? `, +${ds.length - 12}` : ''}`,
    );
  }
  const importers = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT DISTINCT target_name AS t, file_path AS f FROM unresolved_refs WHERE kind = 'imports'`,
    )
    .all() as { t: string; f: string }[]) {
    if (r.t.startsWith('.') || r.t.startsWith('/') || isTest(r.f)) continue;
    const parts = r.t.split(r.f.endsWith('.py') ? '.' : '/');
    const pkg = r.t.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    importers.set(pkg, (importers.get(pkg) ?? 0) + 1);
  }
  const runtimeNames = new Set(
    declared.filter((d) => d.runtime && !localNames.has(d.name)).map((d) => d.name),
  );
  const mostImported = [...importers]
    .filter(([n]) => runtimeNames.has(n) && !shownDeps.has(n))
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, 12);
  if (mostImported.length) {
    basics.push(
      `- ${shownDeps.size ? 'Other dependencies' : 'Key dependencies'} by importing files: ${mostImported.map(([n, c]) => `${n} (${c})`).join(', ')}`,
    );
  }

  // --- entry points ---------------------------------------------------------
  const shownEntry = new Set<string>();
  // Package-relative description of a manifest's entries.
  const entryParts = (m: Manifest): string | null => {
    const parts: string[] = [];
    const dir = m.dir;
    const describe = (target: string): string => {
      const src = sourceFor(dir, target, fileSet);
      if (src) shownEntry.add(dir === '' ? src : `${dir}/${src}`);
      return src ?? target;
    };
    const j = m.json;
    if (j) {
      const ex = j.exports;
      const subpaths =
        ex && typeof ex === 'object' && !Array.isArray(ex)
          ? Object.keys(ex).filter((k) => k.startsWith('.') && !k.endsWith('package.json'))
          : [];
      if (subpaths.length) {
        const items = subpaths.slice(0, 8).flatMap((k) => {
          const t = exportTarget((ex as Record<string, unknown>)[k]);
          return t ? [`"${k}" → ${describe(t)}`] : [];
        });
        parts.push(
          `exports ${items.join(', ')}${subpaths.length > 8 ? `, +${subpaths.length - 8}` : ''}`,
        );
      } else if (ex !== undefined && exportTarget(ex)) {
        parts.push(`exports → ${describe(exportTarget(ex)!)}`);
      } else {
        for (const k of ['main', 'module'] as const) {
          if (typeof j[k] === 'string') parts.push(`${k} → ${describe(j[k] as string)}`);
        }
      }
      if (typeof j.bin === 'string') parts.push(`bin → ${describe(j.bin)}`);
      else if (j.bin && typeof j.bin === 'object') {
        parts.push(
          `bin ${Object.entries(j.bin as Record<string, unknown>)
            .filter((e): e is [string, string] => typeof e[1] === 'string')
            .map(([k, v]) => `${k} → ${describe(v)}`)
            .join(', ')}`,
        );
      }
    }
    for (const [k, v] of m.pyScripts.slice(0, 4)) parts.push(`script ${k} → ${v}`);
    return parts.length ? parts.join('; ') : null;
  };
  const entries: string[] = [];
  const label = (m: Manifest): string =>
    `${m.name ?? (m.dir || projectName)}${m.dir ? ` (${m.dir})` : ''}`;
  if (rootManifest) {
    const e = entryParts(rootManifest);
    if (e) entries.push(`- ${label(rootManifest)}: ${e}`);
  }
  // Family members with the same entry shape fold into one line.
  const folded = new Map<string, { key: string; shape: string; members: Pkg[] }>();
  for (const pk of subPkgs) {
    const e = entryParts(pk.manifest);
    if (!e) continue;
    const fam = familyOf.get(pk.dir);
    if (!fam) {
      entries.push(`- ${label(pk.manifest)}: ${e}`);
      continue;
    }
    const k = `${fam}\0${e}`;
    const f = folded.get(k) ?? { key: fam, shape: e, members: [] };
    f.members.push(pk);
    if (!folded.has(k)) {
      folded.set(k, f);
      entries.push(k);
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const f = folded.get(entries[i]!);
    if (!f) continue;
    entries[i] =
      f.members.length === 1
        ? `- ${label(f.members[0]!.manifest)}: ${f.shape}`
        : `- ${f.key} (${f.members.length} packages, e.g. ${f.members[0]!.manifest.name ?? f.members[0]!.dir}): each ${f.shape}`;
  }
  // Index / main / CLI files at the top of each package (or the repo) that
  // no manifest entry reached; CLI files (shebang) first.
  const ENTRY_STEMS = new Set(['index', 'main', '__main__', '__init__', 'cli', 'app', 'server']);
  const ENTRY_EXTS = new Set(['ts', 'tsx', 'mts', 'js', 'jsx', 'mjs', 'cjs', 'py']);
  const entryDirs = new Set<string>();
  for (const base of ['', ...subPkgs.filter((p) => individual.has(p.dir)).map((p) => p.dir)]) {
    entryDirs.add(base);
    entryDirs.add(base === '' ? 'src' : `${base}/src`);
  }
  const entryFiles: { path: string; cli: boolean }[] = [];
  for (const f of files) {
    if (!entryDirs.has(dirOf(f)) || !ENTRY_STEMS.has(stemOf(f)) || !ENTRY_EXTS.has(extOf(f))) {
      continue;
    }
    if (isTest(f) || shownEntry.has(f) || f.endsWith('.d.ts')) continue;
    entryFiles.push({ path: f, cli: (readText(f) ?? '').startsWith('#!') });
  }
  entryFiles.sort((a, b) => Number(b.cli) - Number(a.cli) || byName(a.path, b.path));
  // After the top three manifests: a CLI file is often the real entry point.
  const indexLines: string[] = [];
  for (let i = 0; i < entryFiles.length; i += 6) {
    indexLines.push(
      `- ${i === 0 ? 'Index/main files' : 'More index/main files'}: ${entryFiles
        .slice(i, i + 6)
        .map((e) => `${e.path}${e.cli ? ' (CLI, shebang)' : ''}`)
        .join(', ')}`,
    );
  }
  entries.splice(Math.min(3, entries.length), 0, ...indexLines);

  // --- layout -------------------------------------------------------------------
  const layout: string[] = [];
  // Sub-directories of a package (below src/ when most of it lives there).
  const childLines = (dir: string, all: readonly string[], limit: number, indent: string) => {
    const inPkg = all.filter((f) => under(dir, f));
    const srcBase = dir === '' ? 'src' : `${dir}/src`;
    const inSrc = inPkg.filter((f) => under(srcBase, f)).length;
    const base = inSrc > 0 && inSrc * 2 >= inPkg.length ? srcBase : dir;
    const counts = new Map<string, number>();
    for (const f of inPkg) {
      if (!under(base, f)) continue;
      const r = rel(base, f);
      if (r.includes('/'))
        counts.set(r.slice(0, r.indexOf('/')), (counts.get(r.slice(0, r.indexOf('/'))) ?? 0) + 1);
    }
    return [...counts]
      .filter(([c, n]) => n >= 2 && !pkgs.has(base === '' ? c : `${base}/${c}`))
      .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
      .slice(0, limit)
      .map(([c, n]) => {
        const p = base === '' ? c : `${base}/${c}`;
        const purpose = isTestPath(`${p}/x`) ? 'tests' : dirPurpose(p);
        return `${indent}- ${p}/ (${n} files)${purpose ? ` — ${purpose}` : ''}`;
      });
  };
  if (subPkgs.length === 0) {
    // Top-level directories by size; the largest non-test one with its
    // sub-directories.
    const tops = new Map<string, number>();
    for (const f of files) {
      if (f.includes('/'))
        tops.set(f.slice(0, f.indexOf('/')), (tops.get(f.slice(0, f.indexOf('/'))) ?? 0) + 1);
    }
    const ordered = [...tops].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
    const main = ordered.find(([d]) => !isTestPath(`${d}/x`))?.[0];
    for (const [d, n] of ordered) {
      const purpose = isTestPath(`${d}/x`) ? 'tests' : dirPurpose(d);
      layout.push(`- ${d}/ (${n} files)${purpose ? ` — ${purpose}` : ''}`);
      if (d === main) {
        layout.push(...childLines(d, files, 16, '  '));
      }
    }
    const top = files.filter((f) => !f.includes('/')).length;
    if (top) layout.push(`- (${top} files at the root)`);
  } else {
    type Item = { score: number; order: number; lines: string[] };
    const items: Item[] = [];
    let rank = 0;
    for (const p of subPkgs) {
      if (!individual.has(p.dir)) continue;
      const purpose = pkgPurpose(p);
      const name =
        p.manifest.name && p.manifest.name !== basename(p.dir) ? ` (${p.manifest.name})` : '';
      const lines = [
        `- ${p.dir}/${name} — ${p.files.length} files${purpose ? `: ${purpose}` : ''}`,
      ];
      if (rank < 2) lines.push(...childLines(p.dir, p.files, 8, '  '));
      items.push({ score: p.score, order: rank++, lines });
    }
    const families = new Map<string, Pkg[]>();
    for (const p of subPkgs) {
      const k = familyOf.get(p.dir);
      if (k) families.set(k, [...(families.get(k) ?? []), p]);
    }
    for (const [k, members] of families) {
      const parent = dirOf(members[0]!.dir);
      const names = members.map((m) => rel(parent, m.dir)).sort(byName);
      const sample = members.find((m) => m.manifest.description) ?? members[0]!;
      const purpose = pkgPurpose(sample);
      items.push({
        score: members.reduce((n, m) => n + m.score, 0),
        order: rank++,
        lines: [
          `- ${k} — ${members.length} packages, ${members.reduce((n, m) => n + m.files.length, 0)} files: ${names.slice(0, 10).join(', ')}${names.length > 10 ? `, +${names.length - 10}` : ''}${purpose ? `. e.g. ${rel(parent, sample.dir)}: ${purpose}` : ''}`,
        ],
      });
    }
    // The top two packages (with their sub-directories) lead; the rest,
    // families included, follow by score.
    items.sort((a, b) =>
      a.order < 2 || b.order < 2 ? a.order - b.order : b.score - a.score || a.order - b.order,
    );
    for (const it of items) layout.push(...it.lines);
    const other = new Map<string, number>();
    for (const f of files) {
      if (pkgOf(f) !== '' || !f.includes('/')) continue;
      const top = f.slice(0, f.indexOf('/'));
      other.set(top, (other.get(top) ?? 0) + 1);
    }
    if (other.size) {
      layout.push(
        `- Outside packages: ${[...other]
          .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
          .map(([d, n]) => `${d}/ (${n}${isTestPath(`${d}/x`) ? ', tests' : ''})`)
          .join(', ')}`,
      );
    }
  }

  // --- key symbols ----------------------------------------------------------------
  const keySymbols: string[] = [];
  const hubFiles = [...fileIn]
    .filter(([f, s]) => !isTest(f) && s.size >= 2)
    .map(([f, s]) => [f, s.size] as const)
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, 6);
  if (hubFiles.length) {
    keySymbols.push(
      `- Hub files (used by N files): ${hubFiles.map(([f, n]) => `${f} (${n})`).join(', ')}`,
    );
  }
  const ranked = syms
    .filter((s) => SYMBOL_KINDS.has(s.kind) && s.exported && !isTest(s.file))
    .map((s) => ({ s, n: inCount(symIn, s.id) }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n || byName(a.s.name, b.s.name) || byName(a.s.file, b.s.file))
    .slice(0, 40);
  for (const { s, n } of ranked) {
    const head =
      s.sig && (s.kind === 'function' || s.kind === 'component')
        ? `${s.name}${clip(compactSignature(s.sig), 100)}`
        : (declarationHead(sourceLines(s.file)?.[s.line - 1], s.name) ??
          `${s.kind.replace('_', ' ')} ${s.name}`);
    keySymbols.push(`- \`${head}\` — ${s.file}:${s.line} · used by ${n} files`);
  }

  // --- request / handler surfaces -----------------------------------------------
  interface Surface {
    score: number;
    lines: string[];
  }
  const surfaces: Surface[] = [];
  const HANDLER_AFFIX =
    /^(handle|on|do)|(handler|action|route|controller|command|endpoint|page|view)$/g;
  // Each caller's callees by normalized name, with and without a handler
  // affix (deleteAction answers for "delete").
  const callerNames = syms
    .filter((s) => (s.kind === 'function' || s.kind === 'method') && callees.has(s.id))
    .map((s) => {
      const names = new Map<string, string>();
      for (const c of [...callees.get(s.id)!].sort(byName)) {
        const name = symById.get(c)!.name;
        const n = norm(name);
        names.set(n, name);
        if (!names.has(n.replace(HANDLER_AFFIX, ''))) names.set(n.replace(HANDLER_AFFIX, ''), name);
      }
      return { s, names };
    });
  // The function calling the most members of a set (at least 3), as a
  // sub-line: the dispatcher behind a route table.
  const dispatcherOf = (members: readonly string[]): string | null => {
    const want = [...new Set(members.map(norm))];
    let best: { s: Sym; hits: string[] } | null = null;
    for (const { s, names } of callerNames) {
      if (names.size < 3) continue;
      const hits = [...new Set(want.filter((w) => names.has(w)).map((w) => names.get(w)!))];
      if (hits.length < 3) continue;
      if (
        !best ||
        hits.length > best.hits.length ||
        (hits.length === best.hits.length &&
          byName(`${s.file}:${s.name}`, `${best.s.file}:${best.s.name}`) < 0)
      ) {
        best = { s, hits };
      }
    }
    return best
      ? `  - dispatched by \`${best.s.name}\` (${best.s.file}:${best.s.line}), which calls ${best.hits.sort(byName).join(', ')}`
      : null;
  };
  const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

  // 1. Closed name sets: string-literal unions and enums with ≥3 members.
  for (const s of syms) {
    if ((s.kind !== 'type_alias' && s.kind !== 'enum') || isTest(s.file)) continue;
    let values: string[] = [];
    if (s.kind === 'type_alias') {
      if (s.endLine - s.line > 40) continue;
      const src = sourceLines(s.file)
        ?.slice(s.line - 1, s.endLine)
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const at = src ? src.indexOf(s.name) : -1;
      const eq = src && at >= 0 ? src.indexOf('=', at) : -1;
      if (!src || eq < 0) continue;
      const body = src.slice(eq + 1);
      const rest = body.replace(LITERAL, '').replace(/\bLiteral\b/g, '');
      if (!/^[\s|,;()[\]]*$/.test(rest)) continue;
      values = [...new Set([...body.matchAll(LITERAL)].map((m) => m[2]!))];
    } else {
      // Enum members are not graph nodes: read them from the body.
      const src = sourceLines(s.file)
        ?.slice(s.line - 1, s.endLine)
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const open = src?.indexOf('{') ?? -1;
      if (!src || open < 0) continue;
      values = src
        .slice(open + 1, src.lastIndexOf('}'))
        .split(',')
        .map((m) =>
          m
            .trim()
            .split(/[\s=]/)[0]!
            .replace(/^["']|["']$/g, ''),
        )
        .filter((m) => /^[\w$-]+$/.test(m));
    }
    if (values.length < 3) continue;
    const lines = [
      `- \`${s.name}\` (${s.kind === 'enum' ? 'enum' : 'string union'}, ${s.file}:${s.line}): ${values.slice(0, 14).join(', ')}${values.length > 14 ? `, +${values.length - 14}` : ''}`,
    ];
    const d = dispatcherOf(values);
    if (d) lines.push(d);
    surfaces.push({
      score: Math.min(values.length, 10) + 4 * inCount(symIn, s.id) + (d ? 40 : 0),
      lines,
    });
  }

  // 2. Handler directories: ≥3 sibling modules each exporting a function
  // named after the module (actions/session.ts → session, signin/index.ts →
  // signIn; PascalCase in .tsx/.jsx is the component convention, not a
  // handler), or ≥4 sibling modules exporting the same function name.
  const named = new Map<string, Map<string, Sym>>();
  const uniform = new Map<string, Map<string, Sym[]>>();
  for (const s of syms) {
    if (!s.exported || (s.kind !== 'function' && s.kind !== 'component') || isTest(s.file)) {
      continue;
    }
    if (/^[A-Z]/.test(s.name) && /\.[jt]sx$/.test(s.file)) continue;
    const stem = stemOf(s.file);
    const isIndex = INDEX_STEMS.has(stem);
    const key = norm(isIndex ? basename(dirOf(s.file)) : stem);
    const dir = isIndex ? dirOf(dirOf(s.file)) : dirOf(s.file);
    const n = norm(s.name);
    if (key && (n === key || n.replace(HANDLER_AFFIX, '') === key)) {
      let m = named.get(dir);
      if (!m) named.set(dir, (m = new Map()));
      if (!m.has(s.file)) m.set(s.file, s);
    }
    if (!isIndex) {
      let u = uniform.get(dirOf(s.file));
      if (!u) uniform.set(dirOf(s.file), (u = new Map()));
      u.set(s.name, [...(u.get(s.name) ?? []), s]);
    }
  }
  const handlerDirs = new Set<string>();
  for (const [dir, m] of named) {
    if (m.size < 3) continue;
    handlerDirs.add(dir);
    const members = [...m.values()].sort((a, b) => byName(a.file, b.file));
    const shown = members.slice(0, 8).map((s) => `${s.name} (${rel(dir, s.file)}:${s.line})`);
    const lines = [
      `- ${slashed(dir)} — ${members.length} modules, each exporting a function named after it: ${shown.join(', ')}${members.length > 8 ? `, +${members.length - 8}` : ''}`,
    ];
    const d = dispatcherOf(members.map((s) => s.name));
    if (d) lines.push(d);
    const reach = new Set(members.flatMap((s) => [...(symIn.get(s.id) ?? [])])).size;
    surfaces.push({ score: Math.min(members.length, 10) + reach + (d ? 40 : 0), lines });
  }
  for (const [dir, byFn] of uniform) {
    if (handlerDirs.has(dir)) continue;
    const modules = files.filter((f) => dirOf(f) === dir && !isTest(f)).length;
    const best = [...byFn]
      .filter(([name, ss]) => name !== 'default' && ss.length >= 4 && ss.length * 2 >= modules)
      .sort((a, b) => b[1].length - a[1].length || byName(a[0], b[0]))[0];
    if (!best) continue;
    const [fn, ss] = best;
    const names = ss.map((s) => basename(s.file)).sort(byName);
    const reach = new Set(ss.flatMap((s) => [...(symIn.get(s.id) ?? [])])).size;
    surfaces.push({
      score: Math.min(ss.length, 10) + reach,
      lines: [
        `- ${slashed(dir)} — ${ss.length} modules each export \`${fn}\`: ${names.slice(0, 10).join(', ')}${names.length > 10 ? `, +${names.length - 10}` : ''}`,
      ],
    });
  }

  // 3. HTTP verb exports (route handler files).
  const verbFiles = new Map<string, Set<string>>();
  for (const s of syms) {
    if (s.exported && HTTP_VERBS.has(s.name) && !isTest(s.file)) addTo(verbFiles, s.file, s.name);
  }
  if (verbFiles.size) {
    const list = [...verbFiles].sort((a, b) => byName(a[0], b[0]));
    surfaces.push({
      score: 3 * list.length,
      lines: [
        `- HTTP verb exports: ${list
          .slice(0, 10)
          .map(([f, vs]) => `${f} (${[...vs].sort(byName).join(', ')})`)
          .join(', ')}${list.length > 10 ? `, +${list.length - 10} files` : ''}`,
      ],
    });
  }
  surfaces.sort((a, b) => b.score - a.score || byName(a.lines[0]!, b.lines[0]!));
  const surfaceLines = surfaces.flatMap((s) => s.lines);
  if (!surfaceLines.length) {
    surfaceLines.push(
      '- none detected (no string-literal unions, enums, handler directories or HTTP verb exports)',
    );
  }

  // --- tests --------------------------------------------------------------------------
  const tests: string[] = [];
  const testFiles = files.filter(isTest);
  if (testFiles.length) {
    const roots = new Map<string, string[]>();
    for (const f of testFiles) {
      const r = testRootOf(f);
      roots.set(r, [...(roots.get(r) ?? []), f]);
    }
    const scripts = rootManifest?.json?.scripts;
    const script =
      scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>).test : null;
    tests.push(
      `- ${testFiles.length} test files in ${roots.size} places; ${testsOf.size} import the sources they test (tests edges)${typeof script === 'string' ? `; \`test\` script: \`${clip(script, 60)}\`` : ''}`,
    );
    const linked = (tf: string[]): number => tf.reduce((n, f) => n + inCount(testsOf, f), 0);
    const ordered = [...roots].sort(
      (a, b) => linked(b[1]) - linked(a[1]) || b[1].length - a[1].length || byName(a[0], b[0]),
    );
    for (const [root, tf] of ordered) {
      const targets = new Map<string, number>();
      const pairs: string[] = [];
      for (const f of tf.sort(byName)) {
        for (const t of [...(testsOf.get(f) ?? [])].sort(byName)) {
          targets.set(dirOf(t), (targets.get(dirOf(t)) ?? 0) + 1);
          if (stemOf(f).replace(/^test_|_test$/, '') === stemOf(t) && pairs.length < 3) {
            pairs.push(`${rel(root, f)} → ${t}`);
          }
        }
      }
      const top = [...targets]
        .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
        .slice(0, 2)
        .map(([d]) => slashed(d));
      tests.push(
        `- ${slashed(root)}${TEST_SEGMENTS.has(basename(root)) ? '' : ' (co-located)'} — ${tf.length} files${top.length ? `, testing ${top.join(', ')}` : ''}${pairs.length ? `; e.g. ${pairs.join(', ')}` : ''}`,
      );
    }
  }

  // --- decisions --------------------------------------------------------------------
  const decisions = listWaypoints(db, { kind: 'decision', limit: 6 }).map(
    (w) =>
      `- ${new Date(w.ts).toISOString().slice(0, 10)} — ${clip(w.title.replace(/\s+/g, ' '), 140)}`,
  );

  const header = [
    `# Repository overview: ${projectName}`,
    `${num(files.length)} indexed files, ${num(syms.filter((s) => s.kind !== 'file').length)} symbols. Paths are relative to the repository root; \`file:line\` points at a definition.`,
  ];
  return fitSections(
    header,
    [
      { title: 'Basics', lines: basics, min: 3, weight: 1 },
      { title: 'Entry points', lines: entries, min: 2, weight: 1 },
      { title: 'Layout', lines: layout, min: 4, weight: 1.5 },
      { title: 'Key symbols', lines: keySymbols, min: 4, weight: 1.5 },
      { title: 'Request/handler surfaces', lines: surfaceLines, min: 2, weight: 1.2 },
      { title: 'Tests', lines: tests, min: 2, weight: 0.8 },
      { title: 'Recent decisions', lines: decisions, min: 1, weight: 0.4 },
    ],
    budget * CHARS_PER_TOKEN,
  );
};

// ---------------------------------------------------------------------------
// Cache

// Everything the map reads: the indexed files (path, content hash, extractor
// version), the decision waypoints it lists, the project directory name and
// the map version. Cheap: one pass over the files table.
export const overviewFingerprint = (db: SqliteAdapter, projectRoot: string): string => {
  const h = createHash('sha256');
  h.update(`${ORIENTATION_VERSION}\0${EXTRACTOR_VERSION}\0${basename(projectRoot)}\0`);
  for (const r of db
    .prepare(`SELECT path, hash, extractor_version AS v FROM files ORDER BY path`)
    .all() as { path: string; hash: string; v: number | null }[]) {
    h.update(`${r.path}\0${r.hash}\0${r.v ?? ''}\n`);
  }
  for (const r of db
    .prepare(
      `SELECT id, name, created_at FROM nodes
       WHERE type = 'conversation-waypoint' AND json_extract(data, '$.type') = 'decision'
       ORDER BY created_at DESC, rowid DESC LIMIT 6`,
    )
    .all() as { id: string; name: string; created_at: number }[]) {
    h.update(`w\0${r.id}\0${r.name}\0${r.created_at}\n`);
  }
  return h.digest('hex').slice(0, 16);
};

export const readCachedOverview = (db: SqliteAdapter): CachedOverview | null => {
  const raw = getMeta(db, META_OVERVIEW);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as CachedOverview;
    return typeof c.map === 'string' && typeof c.fingerprint === 'string' ? c : null;
  } catch {
    return null;
  }
};

const generate = (
  db: SqliteAdapter,
  projectRoot: string,
  budget: number,
  fingerprint: string,
): CachedOverview => {
  const t0 = performance.now();
  const map = buildOverviewMap(db, projectRoot, { budget });
  const nodes = (db.prepare(`SELECT COUNT(*) AS n FROM nodes`).get() as { n: number }).n;
  return {
    version: ORIENTATION_VERSION,
    fingerprint,
    generated_at: Date.now(),
    nodes,
    elapsed_ms: Math.round((performance.now() - t0) * 10) / 10,
    map,
  };
};

const toOverview = (c: CachedOverview, budget: number, cached: boolean): Overview => ({
  map: c.map,
  generated_at: c.generated_at,
  nodes: c.nodes,
  budget,
  chars: c.map.length,
  est_tokens: estimateTokens(c.map),
  elapsed_ms: c.elapsed_ms,
  cached,
});

// The update pipeline's step: regenerate and store the default-budget map
// unless the cached one was built from the same inputs. Returns whether it
// regenerated.
export const refreshOverview = (db: SqliteAdapter, projectRoot: string): boolean => {
  const fp = overviewFingerprint(db, projectRoot);
  const c = readCachedOverview(db);
  if (c && c.version === ORIENTATION_VERSION && c.fingerprint === fp) return false;
  const fresh = generate(db, projectRoot, DEFAULT_OVERVIEW_BUDGET, fp);
  setMeta(db, META_OVERVIEW, JSON.stringify(fresh));
  return true;
};

// The map for a reader (rig_overview, rig://overview, `rig overview`). The
// default budget is served from the cache when it is current, and otherwise
// regenerated and stored (best effort: a busy database just skips the
// store). Other budgets are generated on the fly.
export const getOverview = (
  db: SqliteAdapter,
  projectRoot: string,
  opts: BuildOverviewOptions = {},
): Overview => {
  const budget = clampBudget(opts.budget);
  const fp = overviewFingerprint(db, projectRoot);
  if (budget === DEFAULT_OVERVIEW_BUDGET) {
    const c = readCachedOverview(db);
    if (c && c.version === ORIENTATION_VERSION && c.fingerprint === fp) {
      return toOverview(c, budget, true);
    }
  }
  const fresh = generate(db, projectRoot, budget, fp);
  if (budget === DEFAULT_OVERVIEW_BUDGET) {
    try {
      setMeta(db, META_OVERVIEW, JSON.stringify(fresh));
    } catch {
      // another process holds the write lock; the next update stores it
    }
  }
  return toOverview(fresh, budget, false);
};
