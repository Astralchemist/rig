// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const DEFAULT_CONFIG = {
  version: 1,
  host: '127.0.0.1',
  port: 7474,
  embedder: { kind: 'local', model: 'Xenova/bge-small-en-v1.5' },
};

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
    writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
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
