// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Rig, RIG_DIR_NAME } from '@rig/core';

// Auto-append .rig/ to a project .gitignore so the local graph + runtime token
// don't end up in version control. Idempotent — checks for an existing entry.
const ensureGitignored = (root: string): boolean => {
  const path = join(root, '.gitignore');
  const entry = '.rig/';
  if (!existsSync(path)) {
    writeFileSync(path, `${entry}\n`);
    return true;
  }
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  if (lines.some((l) => l.trim() === entry || l.trim() === '.rig')) return false;
  const sep = lines.at(-1) === '' ? '' : '\n';
  appendFileSync(path, `${sep}${entry}\n`);
  return true;
};

// Project name for the map title + /health. Prefer package.json "name"; fall
// back to the directory name so unnamed projects still get a stable identity.
export const deriveProjectName = (root: string): string => {
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const name = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch {
      // malformed package.json — fall through to basename
    }
  }
  return basename(root);
};

// Deterministic per-project port in the 7474–7537 window (64 ports). Folding
// the absolute path's char codes means the same root always lands on the same
// port, so two checkouts can run side by side without colliding.
const PORT_BASE = 7474;
const PORT_SPAN = 64;
export const stablePort = (root: string): number => {
  const abs = resolve(root);
  let h = 0;
  for (let i = 0; i < abs.length; i++) h = (h * 31 + abs.charCodeAt(i)) >>> 0;
  return PORT_BASE + (h % PORT_SPAN);
};

const defaultConfig = (root: string) => ({
  version: 1,
  name: deriveProjectName(root),
  host: '127.0.0.1',
  port: stablePort(root),
  embedder: { kind: 'local', model: 'Xenova/bge-small-en-v1.5' },
});

export interface EnsureInitResult {
  rigDir: string;
  created: boolean;
  gitignoreUpdated: boolean;
}

// Idempotent, non-destructive init. Returns whether anything was created so
// callers (the `init` command, the `start` orchestrator) can report it.
export const ensureInit = async (root: string): Promise<EnsureInitResult> => {
  const rigDir = join(root, RIG_DIR_NAME);
  if (existsSync(rigDir)) {
    return { rigDir, created: false, gitignoreUpdated: false };
  }
  const rig = await Rig.init(root);
  const cfgPath = join(rigDir, 'config.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify(defaultConfig(root), null, 2) + '\n');
  }
  rig.close();
  const gitignoreUpdated = ensureGitignored(root);
  return { rigDir, created: true, gitignoreUpdated };
};

export const runInit = async (cwd: string): Promise<void> => {
  const root = resolve(cwd);
  const { rigDir, created, gitignoreUpdated } = await ensureInit(root);
  if (!created) {
    console.log(`rig: already initialized at ${rigDir}`);
    return;
  }
  console.log(`rig: initialized at ${rigDir}`);
  if (gitignoreUpdated) console.log('  .gitignore:       appended .rig/');
  console.log('  next:             `rig index`');
};
