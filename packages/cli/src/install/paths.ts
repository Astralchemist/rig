// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

export const expandHome = (p: string, home: string = homedir()): string => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return resolve(home, p.slice(2));
  return resolve(p);
};

export const expandRelativeTo = (p: string, base: string, home?: string): string => {
  if (p.startsWith('~/') || p === '~') return expandHome(p, home);
  return resolve(base, p);
};

// Project scope writes next to the code (.mcp.json, CLAUDE.md, …); global
// scope writes the user's own config under ~ and applies to every project.
export type Scope = 'project' | 'global';

// A target file's path spells its scope: `~/…` is user-level, anything else is
// relative to the project root.
export const scopeOf = (p: string): Scope =>
  p === '~' || p.startsWith('~/') ? 'global' : 'project';

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
};

// Short, unambiguous label for a written file: relative to the project root
// when it lives there, `~/…` when it lives in the home dir, absolute otherwise.
export const displayPath = (abs: string, projectRoot: string, home: string = homedir()): string => {
  if (isInside(abs, projectRoot)) return relative(projectRoot, abs);
  if (isInside(abs, home)) return `~/${relative(home, abs)}`;
  return abs;
};

// Same directory, even when one spelling goes through a symlink (macOS
// /var → /private/var, or a symlinked $HOME): process.cwd() is already
// resolved, $HOME may not be.
export const samePath = (a: string, b: string): boolean => {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
};
