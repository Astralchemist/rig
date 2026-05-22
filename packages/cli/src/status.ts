import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const runStatus = (cwd: string): void => {
  const rigDir = join(resolve(cwd), '.rig');
  if (!existsSync(rigDir)) {
    console.log('rig: not initialized in this directory. Run `rig init` first.');
    return;
  }
  console.log('rig: initialized');
  console.log('  nodes:            0 (Phase 1 — indexing not implemented)');
  console.log('  edges_structural: 0');
  console.log('  edges_semantic:   0');
  console.log('  files:            0');
};
