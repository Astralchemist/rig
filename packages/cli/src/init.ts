import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Rig, RIG_DIR_NAME } from '@rig/core';

const DEFAULT_CONFIG = {
  version: 1,
  host: '127.0.0.1',
  port: 7474,
  embedder: { kind: 'local', model: 'Xenova/bge-small-en-v1.5' },
};

export const runInit = async (cwd: string): Promise<void> => {
  const root = resolve(cwd);
  const rigDir = join(root, RIG_DIR_NAME);
  if (existsSync(rigDir)) {
    console.log(`rig: already initialized at ${rigDir}`);
    return;
  }
  const rig = await Rig.init(root);
  const cfgPath = join(rigDir, 'config.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  rig.close();
  console.log(`rig: initialized at ${rigDir}`);
  console.log('  schema:           v1');
  console.log('  next:             `rig index`');
};
