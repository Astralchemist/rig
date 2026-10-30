// SPDX-License-Identifier: Apache-2.0
import type { Rig } from '@rig/core';
import { recordActivation } from '@rig/core/db/activation-queries.ts';

export { queryHash } from '@rig/core/db/activation-queries.ts';

export interface ActivationOpts {
  source?: string;
  // queryHash() of the query or anchor that led to these anchors.
  queryHash?: string;
}

export interface ToolContext {
  rig: Rig;
  sessionId: string;
  provenance: string | null;
  // The agent label `rig install` put in this server's args (`--client`), or
  // RIG_CLIENT; recorded with the handshake's client name (session_clients).
  clientLabel?: string | null;
  // Record that a tool call touched these anchors: the one it was asked
  // about, or the ones it returned. Feeds the recency term in magnetic pull
  // and hubness heat. Tools call it exactly when their contract says
  // records_activation. Safe to call on a missing node — just a no-op insert.
  recordActivation: (nodeIds: string | readonly string[], opts?: ActivationOpts) => void;
}

// Build a recordActivation closure bound to a Rig instance + the MCP session.
// The sessionId rides on every recorded activation so rig_hotspots can later
// distinguish broad reuse (many distinct sessions) from session-local hammering.
// One transaction per call, however many anchors a search returned.
export const makeActivationRecorder =
  (rig: Rig, sessionId: string) =>
  (nodeIds: string | readonly string[], opts: ActivationOpts = {}): void => {
    const ids = (typeof nodeIds === 'string' ? [nodeIds] : nodeIds).filter(Boolean);
    if (ids.length === 0) return;
    const db = rig.database.adapter;
    const meta = {
      sessionId,
      ...(opts.queryHash !== undefined ? { queryHash: opts.queryHash } : {}),
    };
    db.transaction(() => {
      for (const id of ids) recordActivation(db, id, opts.source ?? 'mcp', meta);
    })();
  };

export interface ToolHandler {
  name: string;
  tier: 'light' | 'heavy' | 'write' | 'live';
  provenanceRequired?: boolean;
  requiresRationale?: boolean;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    // Extra fields for the JSON-RPC error's `data`, alongside `rigError`.
    public readonly data?: Record<string, unknown>,
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
