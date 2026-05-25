// SPDX-License-Identifier: Apache-2.0
import { Rig } from '@rig/core';
import type { ToolDef } from './tools-baseline.ts';

// A focused slice of the MCP surface — what the agent actually reaches for on
// the bench queries. Full surface is 25+ tools; loading them all into context
// would inflate the system prompt without changing the answers.
export const RIG_TOOLS: ToolDef[] = [
  {
    name: 'rig_search',
    description:
      'FTS5 search over node names + aliases. Returns ranked anchors {id, name, kind, file_path}. Optional kind filter.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', description: 'Filter to one node kind (function, class, interface, file, ...)' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'rig_node',
    description:
      'Return metadata for a single anchor: name, kind, file_path, signature, docstring, neighbor counts.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'rig_callers',
    description: 'List functions that directly call the given function. One-hop.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'rig_neighbors',
    description: 'All edges incident to an anchor in both directions. {src, dst, kind, table}.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'rig_deps',
    description: 'List declared dependencies. Optional manifest_path filter.',
    input_schema: {
      type: 'object',
      properties: { manifest_path: { type: 'string' } },
    },
  },
  {
    name: 'rig_unused_deps',
    description: 'Declared deps with no matching imports in source. Heuristic.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'rig_files',
    description: 'List indexed files, optionally substring-filtered.',
    input_schema: {
      type: 'object',
      properties: { filter: { type: 'string' } },
    },
  },
];

export const runRigTool = (rig: Rig, name: string, input: unknown): string => {
  try {
    const a = (input ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (name === 'rig_search') {
      result = rig.searchNodes(a.query as string, {
        ...(a.kind ? { kind: a.kind as string } : {}),
        ...(typeof a.limit === 'number' ? { limit: a.limit } : {}),
      });
    } else if (name === 'rig_node') result = rig.getNode(a.id as string);
    else if (name === 'rig_callers') result = rig.getCallers(a.id as string);
    else if (name === 'rig_neighbors') result = rig.getNeighbors(a.id as string);
    else if (name === 'rig_deps') result = rig.getDependencies(a.manifest_path as string | undefined);
    else if (name === 'rig_unused_deps') result = rig.getUnusedDependencies();
    else if (name === 'rig_files') result = rig.getFiles(a.filter as string | undefined);
    else return `error: unknown tool ${name}`;
    return JSON.stringify(result, null, 2);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};
