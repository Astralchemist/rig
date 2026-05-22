import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const expandHome = (p: string): string => {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
};

export const expandRelativeTo = (p: string, base: string): string => {
  if (p.startsWith('~/') || p === '~') return expandHome(p);
  return resolve(base, p);
};
