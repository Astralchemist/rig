// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { GeneratedFile } from './types.ts';

export interface Manifest {
  version: 1;
  files: Record<string, string>;
}

export const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 16);

export const computeManifest = (files: GeneratedFile[]): Manifest => {
  const out: Record<string, string> = {};
  for (const f of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    out[f.path] = hashContent(f.content);
  }
  return { version: 1, files: out };
};

export const diffManifests = (
  disk: Manifest,
  fresh: Manifest,
): { kind: 'added' | 'removed' | 'changed'; path: string }[] => {
  const diff: { kind: 'added' | 'removed' | 'changed'; path: string }[] = [];
  const diskKeys = new Set(Object.keys(disk.files));
  const freshKeys = new Set(Object.keys(fresh.files));
  for (const k of freshKeys) {
    if (!diskKeys.has(k)) diff.push({ kind: 'added', path: k });
    else if (disk.files[k] !== fresh.files[k]) diff.push({ kind: 'changed', path: k });
  }
  for (const k of diskKeys) if (!freshKeys.has(k)) diff.push({ kind: 'removed', path: k });
  return diff;
};
