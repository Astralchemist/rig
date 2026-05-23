import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RIG_DIR_NAME } from '../rig-types.ts';
import { DeterministicEmbedder } from './deterministic-embedder.ts';
import { LocalEmbedder } from './local-embedder.ts';
import type { Embedder } from './types.ts';

export type EmbedderKind = 'local' | 'deterministic';

interface RigConfig {
  embedder?: { kind?: EmbedderKind; model?: string };
}

export const selectEmbedder = (projectRoot: string): Embedder => {
  const kind = readEmbedderKind(projectRoot);
  if (kind === 'deterministic') return new DeterministicEmbedder();
  return new LocalEmbedder();
};

const readEmbedderKind = (projectRoot: string): EmbedderKind => {
  const cfgPath = join(projectRoot, RIG_DIR_NAME, 'config.json');
  if (!existsSync(cfgPath)) return 'local';
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as RigConfig;
    return cfg.embedder?.kind ?? 'local';
  } catch {
    return 'local';
  }
};
