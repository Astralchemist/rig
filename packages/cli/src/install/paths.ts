// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const expandHome = (p: string, home: string = homedir()): string => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return resolve(home, p.slice(2));
  return resolve(p);
};

export const expandRelativeTo = (p: string, base: string, home?: string): string => {
  if (p.startsWith('~/') || p === '~') return expandHome(p, home);
  return resolve(base, p);
};
