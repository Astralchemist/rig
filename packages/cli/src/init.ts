import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_CONFIG = {
  version: 1,
  host: '127.0.0.1',
  port: 7474,
  embedder: { kind: 'local', model: 'Xenova/bge-small-en-v1.5' },
};

export const runInit = (cwd: string): void => {
  const root = resolve(cwd);
  const rigDir = join(root, '.rig');
  if (existsSync(rigDir)) {
    console.log(`rig: already initialized at ${rigDir}`);
    return;
  }
  mkdirSync(rigDir, { recursive: true });
  writeFileSync(join(rigDir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  console.log(`rig: initialized at ${rigDir}`);
  console.log('  next: `rig index` (Phase 1 — not implemented yet)');
};
