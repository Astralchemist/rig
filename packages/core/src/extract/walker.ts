import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isSupportedSource } from './grammars.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.rig', 'vendor', '.next']);

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

export async function* walkProject(root: string): AsyncGenerator<WalkedFile> {
  const abs = resolve(root);
  const ig = loadGitignore(abs);
  yield* visit(abs, abs, ig);
}

async function* visit(dir: string, root: string, ig: Ignore): AsyncGenerator<WalkedFile> {
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
      yield* visit(abs, root, ig);
    } else if (info.isFile() && isSupportedSource(abs)) {
      yield { absPath: abs, relPath: rel };
    }
  }
}
