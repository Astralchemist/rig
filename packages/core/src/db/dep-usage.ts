// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, posix, relative } from 'node:path';
import type { SqliteAdapter } from './adapter.ts';

// Most declared dependencies are never imported: compilers, linters, test
// runners, type packages, plugins. The dependency-report evaluation
// (scripts/deps-eval) found 82 of 86 "unused" flags were used this way. These
// are the other ways a dependency gets used, read from the files that say so:
// commands in scripts and CI, mentions in config files, `@types` pairs,
// workspace packages and peers.

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.rig',
  'vendor',
  '.next',
  'coverage',
  'venv',
  '.venv',
  'target',
  '.turbo',
  '.svelte-kit',
  '.nuxt',
  'out',
  '__pycache__',
]);

// Files whose lines are commands.
const isCommandFile = (rel: string): boolean => {
  const b = basename(rel);
  return (
    /^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/.test(rel) ||
    /^(Makefile|makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py|Procfile|Dockerfile|\.pre-commit-config\.yaml|lefthook\.ya?ml|\.gitlab-ci\.yml)$/.test(
      b,
    ) ||
    /\.(sh|bash|zsh)$/.test(b) ||
    // Extensionless executables under scripts/ or bin/ (httpx's scripts/check).
    (/(^|\/)(scripts|bin)\/[^/.]+$/.test(rel) && !b.includes('.')) ||
    /(^|\/)\.husky\/[^/]+$/.test(rel)
  );
};

// Files that configure tools.
const isConfigFile = (rel: string): boolean => {
  const b = basename(rel);
  return (
    /^[tj]sconfig(\.[\w-]+)*\.json$/.test(b) ||
    /^\.(prettierrc|eslintrc|babelrc|stylelintrc|mocharc|swcrc|lintstagedrc|releaserc|commitlintrc|markdownlint)(\.[\w]+)?$/.test(
      b,
    ) ||
    /\.config\.(js|cjs|mjs|ts|cts|mts|json)$/.test(b) ||
    /^(mkdocs\.ya?ml|setup\.cfg|tox\.ini|pyproject\.toml|deno\.jsonc?|typedoc\.json|turbo\.json|nx\.json|biome\.jsonc?|renovate\.json|\.pre-commit-config\.yaml|pytest\.ini|mypy\.ini|\.coveragerc|conftest\.py)$/.test(
      b,
    ) ||
    /(^|\/)\.storybook\/main\.[cm]?[jt]s$/.test(rel)
  );
};

const walk = (root: string, onFile: (rel: string) => void): void => {
  const stack = [''];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const rel = dir ? `${dir}/${e}` : e;
      let st;
      try {
        st = statSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(rel);
      else if (st.size < 512_000) onFile(rel);
      if (++seen > 200_000) return;
    }
  }
};

const read = (abs: string): string => {
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
};

// Commands and executables a few common packages install under another name.
// Anything else is matched by its package name and the bins found in
// node_modules, when installed.
const KNOWN_BINS: Readonly<Record<string, readonly string[]>> = {
  typescript: ['tsc', 'tsserver'],
  '@typescript/native-preview': ['tsgo'],
  '@angular/cli': ['ng'],
  '@biomejs/biome': ['biome'],
  '@changesets/cli': ['changeset'],
  '@playwright/test': ['playwright'],
  '@sveltejs/kit': ['svelte-kit'],
  '@sveltejs/package': ['svelte-package'],
  '@vue/cli-service': ['vue-cli-service'],
  'npm-run-all': ['run-s', 'run-p', 'npm-run-all'],
  'npm-run-all2': ['run-s', 'run-p', 'npm-run-all'],
  'ts-node': ['ts-node', 'ts-node-esm'],
  'vite-plus': ['vp'],
};

// Packages a framework loads for the app without the app importing them, as
// its peers. Counted when the same manifest declares the framework.
const FRAMEWORK_PEERS: Readonly<Record<string, readonly string[]>> = {
  next: ['react', 'react-dom'],
  gatsby: ['react', 'react-dom'],
  '@remix-run/dev': ['react', 'react-dom', '@remix-run/react', '@remix-run/node'],
  '@react-router/dev': ['react', 'react-dom'],
  'solid-start': ['solid-js', '@solidjs/router', '@solidjs/meta'],
  '@solidjs/start': ['solid-js', '@solidjs/router', '@solidjs/meta'],
  '@sveltejs/kit': ['svelte', '@sveltejs/vite-plugin-svelte'],
  '@sveltejs/vite-plugin-svelte': ['svelte'],
  nuxt: ['vue', 'vue-router'],
  astro: ['vite'],
  '@builder.io/qwik-city': ['@builder.io/qwik'],
  expo: ['react', 'react-native'],
};

const installedBins = (projectRoot: string, manifestDir: string, name: string): string[] => {
  let dir = manifestDir;
  for (;;) {
    const pj = join(projectRoot, dir, 'node_modules', name, 'package.json');
    if (existsSync(pj)) {
      try {
        const bin = (JSON.parse(read(pj)) as { bin?: string | Record<string, string> }).bin;
        if (typeof bin === 'string') return [name.split('/').pop()!];
        if (bin) return Object.keys(bin);
      } catch {
        // unreadable manifest: no bins
      }
      return [];
    }
    if (!dir) return [];
    dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
  }
};

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// A command token: at a word start in shell text (after space, start, quote,
// `;`, `&`, `|`, `(`, `}`, `/` or `=`), followed by space, end, quote or `;`.
const commandRe = (word: string): RegExp =>
  new RegExp(`(^|[\\s"'\`;&|(}/=])${esc(word)}(?=$|[\\s"'\`;&|)]|:)`, 'm');
// A mention in config: the name as a quoted string, a key, a path prefix or a
// bare word bounded by non-name characters.
const mentionRe = (word: string): RegExp =>
  new RegExp(`(^|[^A-Za-z0-9_@/.-])${esc(word)}($|[^A-Za-z0-9_-])`, 'm');

export interface UsageContext {
  commands: string;
  configs: string;
  /** Tools named by their own config files: .prettierrc → prettier, vite.config.ts → vite. */
  configuredTools: Set<string>;
  hasTypeScript: boolean;
  /** Local package names → their directory (workspaces). */
  localPackages: Map<string, string>;
  /** Directories some resolved import lands in. */
  importedDirs: Set<string>;
}

const DEP_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
  'overrides',
  'resolutions',
  'pnpm',
  'name',
  'version',
  'description',
  'keywords',
  'repository',
  'homepage',
  'bugs',
  'author',
  'contributors',
  'license',
  'funding',
]);

/** Read what the project's scripts, CI and config files say. */
export const usageContext = (db: SqliteAdapter, projectRoot: string): UsageContext => {
  const commands: string[] = [];
  const configs: string[] = [];
  const localPackages = new Map<string, string>();
  const configuredTools = new Set<string>();
  let hasTypeScript = false;
  walk(projectRoot, (rel) => {
    if (/\.(ts|tsx|mts|cts)$/.test(rel)) hasTypeScript = true;
    const b = basename(rel);
    if (isConfigFile(rel) || isCommandFile(rel)) {
      const tool = toolOfConfig(b);
      if (tool) configuredTools.add(tool);
    }
    if (b === 'package.json') {
      try {
        const pj = JSON.parse(read(join(projectRoot, rel))) as Record<string, unknown>;
        if (typeof pj.name === 'string')
          localPackages.set(pj.name, posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
        if (pj.scripts && typeof pj.scripts === 'object')
          commands.push(...Object.values(pj.scripts as Record<string, unknown>).map(String));
        // Inline tool config (`"prettier": {...}`, `"eslintConfig"`, `"jest"`).
        for (const [k, v] of Object.entries(pj))
          if (!DEP_KEYS.has(k) && k !== 'scripts') configs.push(`${k} ${JSON.stringify(v)}`);
      } catch {
        // malformed package.json: nothing to read
      }
      return;
    }
    if (isCommandFile(rel)) commands.push(read(join(projectRoot, rel)));
    if (isConfigFile(rel)) {
      let text = read(join(projectRoot, rel));
      // The dependency lists themselves aren't uses.
      if (b === 'pyproject.toml') text = stripPyprojectDeps(text);
      if (b === 'setup.cfg') text = text.replace(/^install_requires\s*=[\s\S]*?(?=^\S)/m, '');
      configs.push(text);
    }
  });
  // Directories that resolved imports land in: a workspace package is used
  // when some file imports a file inside it.
  const importedDirs = new Set<string>();
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(t.data, '$.filePath') AS path
       FROM edges e JOIN nodes t ON t.id = e.dst
       WHERE e.kind = 'imports'`,
    )
    .all() as { path: string | null }[];
  for (const r of rows) {
    let d = r.path ? posix.dirname(r.path) : '.';
    while (d && d !== '.') {
      importedDirs.add(d);
      d = posix.dirname(d);
    }
  }
  return {
    commands: commands.join('\n'),
    configs: configs.join('\n'),
    configuredTools,
    hasTypeScript,
    localPackages,
    importedDirs,
  };
};

// The tool a config file belongs to, from its name: `.prettierrc.json`,
// `prettier.config.js` → prettier; `.eslintrc.cjs`, `eslint.config.mjs` →
// eslint; `tsconfig.build.json` → typescript; `lefthook.yml` → lefthook.
const toolOfConfig = (b: string): string | null => {
  if (/^[tj]sconfig(\.|$)/.test(b)) return 'typescript';
  let m = /^\.([a-z][a-z0-9-]*?)rc(\.[a-z]+)*$/.exec(b);
  if (m) return m[1]!;
  m = /^([a-z][a-z0-9-]*)\.config\.[a-z]+$/.exec(b);
  if (m) return m[1]!;
  m = /^(lefthook|mkdocs|turbo|biome|typedoc|renovate|deno)\.[a-z]+$/.exec(b);
  return m ? m[1]! : null;
};

// pyproject.toml without its dependency arrays, so declarations aren't
// mistaken for configuration that names the package.
const stripPyprojectDeps = (text: string): string => {
  const out: string[] = [];
  let section = '';
  let inArray = false;
  for (const line of text.split('\n')) {
    const h = /^\s*\[+([^\]]+)\]+/.exec(line);
    if (h) {
      section = h[1]!.trim();
      inArray = false;
      out.push(line);
      continue;
    }
    const depSection =
      section === 'project.optional-dependencies' ||
      section === 'dependency-groups' ||
      (section.startsWith('tool.poetry') && /dependencies/.test(section));
    if (inArray) {
      if (/\]\s*(#.*)?$/.test(line)) inArray = false;
      continue;
    }
    if (
      depSection ||
      (section === 'project' && /^\s*dependencies\s*=/.test(line)) ||
      /^\s*requires\s*=/.test(line)
    ) {
      if (/=\s*\[/.test(line) && !/\]\s*(#.*)?$/.test(line)) inArray = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/**
 * Why a declared dependency counts as used although nothing imports it, or
 * null when nothing shows it is.
 */
export const nonImportUse = (
  ctx: UsageContext,
  projectRoot: string,
  dep: { name: string; source: string; manifest: string; spec: string; isPeer: boolean },
  isImported: (pkg: string) => boolean,
  siblings?: Map<string, Set<string>>,
): string | null => {
  const { name, source } = dep;
  const manifestDir = posix.dirname(dep.manifest) === '.' ? '' : posix.dirname(dep.manifest);
  const sibling = siblings?.get(dep.manifest) ?? new Set<string>();
  // A library's peer dependency is its contract with its users.
  if (dep.isPeer) return 'peer dependency';
  if (source === 'npm') {
    // Workspace packages: imports of them resolve to files.
    const local = ctx.localPackages.get(name);
    if (local !== undefined || /^(workspace|file|link):/.test(dep.spec)) {
      if (local && ctx.importedDirs.has(local)) return 'workspace package, imported';
    }
    if (name.startsWith('@types/') || name === 'bun-types') {
      const x = name === 'bun-types' ? 'bun' : name.slice(7);
      const target = x.includes('__') ? `@${x.replace('__', '/')}` : x;
      if ((target === 'node' || target === 'bun') && ctx.hasTypeScript) return 'runtime types';
      if (isImported(target)) return `types for ${target}, which is imported`;
    }
    for (const [fw, peers] of Object.entries(FRAMEWORK_PEERS))
      if (peers.includes(name) && sibling.has(fw)) return `loaded by ${fw}`;
    const short = name.startsWith('@') ? null : name;
    if (ctx.configuredTools.has(name) || (short && ctx.configuredTools.has(short)))
      return 'has its own config file';
    if (name === 'tslib' && /"importHelpers"\s*:\s*true/.test(ctx.configs))
      return 'tsconfig importHelpers';
    // @vitest/<x> add-ons are switched on by vitest flags or config: --ui, --coverage, browser.
    const vt = /^@vitest\/(ui|coverage-[a-z0-9]+|browser|web-worker)$/.exec(name);
    if (vt) {
      const flag = vt[1]!.startsWith('coverage') ? 'coverage' : vt[1]!;
      if (new RegExp(`--${flag}\\b|\\b${flag}\\s*:`).test(ctx.commands + '\n' + ctx.configs))
        return `vitest ${flag}`;
    }
    const bins = new Set([
      name,
      ...(KNOWN_BINS[name] ?? []),
      ...installedBins(projectRoot, manifestDir, name),
    ]);
    for (const b of bins) if (commandRe(b).test(ctx.commands)) return `run as \`${b}\``;
    if (mentionRe(name).test(ctx.configs)) return 'named in a config file';
    // Plugins are named by their short form: eslint-plugin-x → plugin:x/ or "x".
    const plugin =
      /^(?:(@[^/]+)\/)?(eslint|prettier|stylelint|babel|postcss|rollup|vite|tailwindcss)-(?:plugin|config|preset)(?:-(.+))?$/.exec(
        name,
      );
    if (plugin) {
      const short = plugin[3] ?? plugin[1];
      if (short && new RegExp(`plugin:${esc(short)}/|["'\`]${esc(short)}["'\`/]`).test(ctx.configs))
        return 'plugin named in a config file';
    }
    // jest loads its coverage provider from config or --coverage.
    if (/^@jest\/coverage-/.test(name) && /coverage/.test(ctx.configs + ctx.commands))
      return 'coverage provider';
    return null;
  }
  if (source === 'pypi') {
    const lower = name.toLowerCase();
    const forms = new Set([lower, lower.replace(/[-.]/g, '_')]);
    for (const f of forms)
      if (commandRe(f).test(ctx.commands) || new RegExp(`-m\\s+${esc(f)}\\b`).test(ctx.commands))
        return `run as \`${f}\``;
    for (const f of forms) if (mentionRe(f).test(ctx.configs)) return 'named in a config file';
    // mkdocs-<x> themes and plugins are named by <x> in mkdocs.yml.
    const mk = /^mkdocs-(.+)$/.exec(lower);
    if (mk && mentionRe(mk[1]!).test(ctx.configs)) return 'named in mkdocs.yml';
    // types-<x> and <x>-stubs serve the type checker for x.
    const stub =
      /^types-(.+)$/.exec(lower) ?? /^(.+)-stubs$/.exec(lower) ?? /^(.+)-typing$/.exec(lower);
    if (stub && isImported(stub[1]!.replace(/-/g, '_'))) return `type stubs for ${stub[1]}`;
    return null;
  }
  return null;
};

export const relativeTo = (root: string, abs: string): string => relative(root, abs);
