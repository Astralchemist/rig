// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isSupportedSource } from './grammars.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.rig', 'vendor', '.next']);

// Minimal glob → regex. Supports **, *, ?, character classes. Cheap enough to
// run per file; avoids pulling in another dep just for include/exclude.
const globToRegex = (pat: string): RegExp => {
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i]!;
    if (ch === '*' && pat[i + 1] === '*') {
      // ** — match any number of path segments
      re += '.*';
      i += 2;
      if (pat[i] === '/') i++;
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$(){}|\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
};

const matchesAny = (path: string, patterns: RegExp[]): boolean =>
  patterns.some((re) => re.test(path));

const loadGitignore = (root: string): Ignore => {
  const ig = ignore();
  const gi = join(root, '.gitignore');
  if (existsSync(gi)) ig.add(readFileSync(gi, 'utf-8'));
  return ig;
};

export interface WalkedFile {
  absPath: string;
  relPath: string;
}

export interface WalkOptions {
  // Only yield files whose relative path matches at least one include pattern.
  // If empty/undefined, everything passes the include filter.
  include?: readonly string[] | undefined;
  // Skip files whose relative path matches any exclude pattern.
  exclude?: readonly string[] | undefined;
}

// The include/exclude half of the walk, for paths that may no longer exist on
// disk: the update pipeline only treats a known file as deleted when this walk
// could have yielded it, so `index --include` never deletes other files.
export const makeWalkFilter = (opts: WalkOptions = {}): ((relPath: string) => boolean) => {
  const include = (opts.include ?? []).map(globToRegex);
  const exclude = (opts.exclude ?? []).map(globToRegex);
  return (rel) => {
    if (exclude.length > 0 && matchesAny(rel, exclude)) return false;
    return include.length === 0 || matchesAny(rel, include);
  };
};

export async function* walkProject(
  root: string,
  opts: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const abs = resolve(root);
  const ig = loadGitignore(abs);
  const include = (opts.include ?? []).map(globToRegex);
  const exclude = (opts.exclude ?? []).map(globToRegex);
  yield* visit(abs, abs, ig, include, exclude);
}

async function* visit(
  dir: string,
  root: string,
  ig: Ignore,
  include: RegExp[],
  exclude: RegExp[],
): AsyncGenerator<WalkedFile> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const rel = relative(root, abs);
    if (rel && ig.ignores(rel)) continue;
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      yield* visit(abs, root, ig, include, exclude);
    } else if (info.isFile() && isSupportedSource(abs)) {
      if (exclude.length > 0 && matchesAny(rel, exclude)) continue;
      if (include.length > 0 && !matchesAny(rel, include)) continue;
      yield { absPath: abs, relPath: rel };
    }
  }
}
