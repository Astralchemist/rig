// SPDX-License-Identifier: Apache-2.0
// The rig-search arm: rig's search-facing MCP tools, run through the same
// generated handlers (contract validation included) and described with the
// same manifest entries the MCP server sends on tools/list. Nothing here is a
// copy, so a change to search, a tool impl or a contract shows up in the bench
// without touching this file.
import type { Rig } from '@rig/core';
import { ToolError, dispatchToolCall, type ToolContext } from '@rig/mcp/dispatch.ts';
import { buildHandlersMap } from '@rig/mcp/server-handlers.ts';
import manifestJson from '../../generated/mcp/tools-manifest.json' with { type: 'json' };
import * as handlersModule from '../../generated/mcp/handlers-index.ts';
import type { ToolDef } from './types.ts';

export const RIG_SEARCH_TOOL_NAMES = [
  'rig_search',
  'rig_context',
  'rig_explore',
  'rig_node',
  'rig_callers',
  'rig_neighbors',
  'rig_files',
] as const;

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// `$schema` is JSON-Schema metadata, not part of the tool's input shape, and
// some providers reject unknown top-level keywords.
const toolDef = (t: ManifestTool): ToolDef => {
  const { $schema: _drop, ...schema } = t.inputSchema;
  return { name: t.name, description: t.description, input_schema: schema };
};

const manifestTools = (manifestJson as { tools: ManifestTool[] }).tools;

// Manifest entries for the named tools, as tools/list sends them.
export const manifestToolDefs = (names: readonly string[]): ToolDef[] =>
  names.map((name) => {
    const entry = manifestTools.find((t) => t.name === name);
    if (!entry) throw new Error(`bench: ${name} is missing from the tools manifest`);
    return toolDef(entry);
  });

export const RIG_SEARCH_TOOLS: ToolDef[] = manifestToolDefs(RIG_SEARCH_TOOL_NAMES);

// The MCP session a runner's calls belong to. Write tools need provenance, as
// the server stamps it (ai:<client>) once the client has introduced itself.
export interface RigToolSession {
  sessionId: string;
  provenance: string | null;
}

let handlers: ReturnType<typeof buildHandlersMap> | null = null;

// Run the named tools through the generated handlers. Activations are not
// recorded: they would carry state from one run into the next, so trial order
// would change the results.
export const makeRigToolRunner = (
  rig: Rig,
  names: readonly string[],
  session: RigToolSession = { sessionId: 'bench', provenance: null },
) => {
  handlers ??= buildHandlersMap(handlersModule as unknown as Record<string, unknown>);
  const map = handlers;
  const ctx: ToolContext = { rig, ...session, recordActivation: () => {} };
  const allowed = new Set<string>(names);
  return async (name: string, input: unknown): Promise<string> => {
    if (!allowed.has(name)) return `error: unknown tool ${name}`;
    try {
      // Serialized as the MCP server does in tools/call.
      return JSON.stringify(await dispatchToolCall(name, input ?? {}, ctx, map));
    } catch (err) {
      if (err instanceof ToolError) return `error: ${err.code}: ${err.message}`;
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
};

export const makeRigSearchRunner = (rig: Rig) => makeRigToolRunner(rig, RIG_SEARCH_TOOL_NAMES);
