import { join, resolve } from 'node:path';
import type { Node as ExtractNode } from './extract/upstream-types.ts';
import { DB_FILE_NAME, RIG_DIR_NAME } from './rig-types.ts';
import type { RigNode } from './types.ts';

export const rigDirOf = (root: string): string => join(resolve(root), RIG_DIR_NAME);
export const dbPathOf = (root: string): string => join(rigDirOf(root), DB_FILE_NAME);

export const toRigNode = (n: ExtractNode): RigNode => ({
  id: n.id,
  type: n.kind,
  name: n.name,
  data: n as unknown as Record<string, unknown>,
  pull_score: 0,
  created_at: n.updatedAt,
  updated_at: n.updatedAt,
});
