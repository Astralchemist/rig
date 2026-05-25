// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const BASELINE_TOOLS: ToolDef[] = [
  {
    name: 'rg',
    description:
      'Run ripgrep against the repo. Pass any flags as a single args array. Returns up to 200 matching lines with file:line context.',
    input_schema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'ripgrep argv' },
      },
      required: ['args'],
    },
  },
  {
    name: 'read_file',
    description: 'Read up to N lines of a file relative to the repo root. Returns the slice.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 500 },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files/dirs at a given path relative to the repo root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

interface RgArgs { args: string[]; }
interface ReadArgs { path: string; offset?: number; limit?: number; }
interface ListArgs { path: string; }

export const runBaselineTool = (
  repoRoot: string,
  name: string,
  input: unknown,
): string => {
  try {
    if (name === 'rg') {
      const { args } = input as RgArgs;
      const out = execFileSync('rg', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 4 * 1024 * 1024,
      });
      const lines = out.split('\n');
      if (lines.length <= 200) return out;
      return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more lines truncated)`;
    }
    if (name === 'read_file') {
      const { path, offset = 0, limit = 500 } = input as ReadArgs;
      const abs = resolve(repoRoot, path);
      if (!abs.startsWith(resolve(repoRoot))) return 'error: path escapes repo root';
      const content = readFileSync(abs, 'utf-8').split('\n');
      const slice = content.slice(offset, offset + limit);
      return slice.map((l, i) => `${(offset + i + 1).toString().padStart(5)}: ${l}`).join('\n');
    }
    if (name === 'list_dir') {
      const { path } = input as ListArgs;
      const abs = resolve(repoRoot, path);
      if (!abs.startsWith(resolve(repoRoot))) return 'error: path escapes repo root';
      const entries = execFileSync('ls', ['-la', abs], { encoding: 'utf-8' });
      return entries;
    }
    return `error: unknown tool ${name}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};
