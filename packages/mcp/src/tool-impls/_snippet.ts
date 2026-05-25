// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RigNode } from '@rig/core';

export interface NodeView {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNumber = (v: unknown): number => (typeof v === 'number' ? v : 0);

export const viewOf = (n: RigNode): NodeView => {
  const d = n.data;
  return {
    id: n.id,
    name: n.name,
    kind: n.type,
    file_path: asString(d.filePath),
    start_line: asNumber(d.startLine),
    end_line: asNumber(d.endLine),
  };
};

// Read a snippet from disk, sliced to the node's line range. Empty string on
// any read error so callers don't have to handle missing files.
export const readSnippet = async (
  projectRoot: string,
  view: NodeView,
): Promise<string> => {
  if (!view.file_path) return '';
  try {
    const full = await readFile(resolve(projectRoot, view.file_path), 'utf-8');
    const lines = full.split('\n');
    const startIdx = Math.max(0, view.start_line - 1);
    const endIdx = Math.max(view.start_line, view.end_line);
    return lines.slice(startIdx, endIdx).join('\n');
  } catch {
    return '';
  }
};
