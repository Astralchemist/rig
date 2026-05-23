import type { Rig } from '@rig/core';
import { recordActivation } from '@rig/core/db/activation-queries.ts';

export interface ToolContext {
  rig: Rig;
  sessionId: string;
  isMainSession: boolean;
  provenance: string | null;
  // Record that a tool query touched a specific anchor. Feeds the recency term
  // in magnetic pull. Safe to call on a missing node — just a no-op insert.
  recordActivation: (nodeId: string, source?: string) => void;
}

// Build a recordActivation closure bound to a Rig instance.
export const makeActivationRecorder =
  (rig: Rig) =>
  (nodeId: string, source = 'mcp'): void => {
    if (!nodeId) return;
    recordActivation(rig.database.adapter, nodeId, source);
  };

export interface ToolHandler {
  name: string;
  tier: 'light' | 'heavy' | 'write' | 'live';
  mainSessionForbidden?: boolean;
  provenanceRequired?: boolean;
  requiresRationale?: boolean;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Look up a handler by name and invoke it. ToolError is re-thrown unchanged so
 * the JSON-RPC layer can translate the `.code` into `data.rigError`; any other
 * thrown error bubbles up as-is (the transport will wrap it as InternalError).
 */
export async function dispatchToolCall(
  name: string,
  args: unknown,
  ctx: ToolContext,
  handlers: Map<string, ToolHandler>,
): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) {
    throw new ToolError('TOOL_NOT_FOUND', name);
  }
  try {
    return await handler.run(args, ctx);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw err;
  }
}
