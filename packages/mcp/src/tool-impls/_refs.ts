import type { RigNode } from '@rig/core';

export interface NodeRef {
  id: string;
  name: string;
  kind: string;
  file_path?: string;
}

export const toNodeRef = (n: RigNode): NodeRef => {
  const fp = n.data?.filePath;
  return {
    id: n.id,
    name: n.name,
    kind: n.type,
    ...(typeof fp === 'string' && fp ? { file_path: fp } : {}),
  };
};
