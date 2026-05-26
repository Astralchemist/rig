// SPDX-License-Identifier: Apache-2.0
import pkg from '../../../package.json' with { type: 'json' };
import type { ToolHandler, ToolContext } from './dispatch.ts';
import { ToolError, dispatchToolCall } from './dispatch.ts';
import {
  ErrorCodes,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type StdioTransport,
} from './transport.ts';

export interface ToolManifestEntry {
  name: string;
  description: string;
  tier: string;
  inputSchema: unknown;
  outputSchema: unknown;
  errors: string[];
}

export interface ToolsManifest {
  version: number;
  tools: ToolManifestEntry[];
}

export const buildHandlersMap = (
  exports: Record<string, unknown>,
): Map<string, ToolHandler> => {
  const out = new Map<string, ToolHandler>();
  for (const value of Object.values(exports)) {
    if (!value || typeof value !== 'object') continue;
    const h = value as Partial<ToolHandler>;
    if (typeof h.name === 'string' && typeof h.run === 'function' && typeof h.tier === 'string') {
      out.set(h.name, h as ToolHandler);
    }
  }
  return out;
};

const SERVER_INFO = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'rig', version: (pkg as { version: string }).version },
};

const isParams = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const handleToolsCall = async (
  params: unknown,
  ctx: ToolContext,
  handlers: Map<string, ToolHandler>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
  const p = isParams(params) ? params : {};
  const name = typeof p.name === 'string' ? p.name : '';
  const args = p.arguments;
  const result = await dispatchToolCall(name, args, ctx, handlers);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
};

export const makeMessageHandler = (
  transport: StdioTransport,
  manifest: ToolsManifest,
  handlers: Map<string, ToolHandler>,
  ctx: ToolContext,
) => {
  return async (message: JsonRpcRequest | JsonRpcNotification): Promise<void> => {
    const hasId = 'id' in message && message.id !== undefined;
    const id = hasId ? (message as JsonRpcRequest).id : null;
    const method = message.method;

    if (!hasId) {
      // Notifications are fire-and-forget; only `notifications/initialized` is
      // expected during handshake — silently acknowledge everything else.
      return;
    }

    try {
      if (method === 'initialize') {
        const params = (message as JsonRpcRequest).params;
        const clientInfo =
          isParams(params) && isParams(params.clientInfo)
            ? (params.clientInfo as { name?: unknown; version?: unknown })
            : null;
        const clientName =
          clientInfo && typeof clientInfo.name === 'string' ? clientInfo.name : 'unknown';
        // Stamp this MCP session as ai:<client> so write tools have provenance.
        ctx.provenance = `ai:${clientName}`;
        transport.sendResult(id as string | number, SERVER_INFO);
        return;
      }
      if (method === 'tools/list') {
        transport.sendResult(id as string | number, { tools: manifest.tools });
        return;
      }
      if (method === 'tools/call') {
        const result = await handleToolsCall(
          (message as JsonRpcRequest).params,
          ctx,
          handlers,
        );
        transport.sendResult(id as string | number, result);
        return;
      }
      transport.sendError(id as string | number, ErrorCodes.MethodNotFound, `Method not found: ${method}`);
    } catch (err) {
      if (err instanceof ToolError) {
        transport.sendError(
          id as string | number,
          ErrorCodes.InternalError,
          err.message,
          { rigError: err.code },
        );
        return;
      }
      transport.sendError(
        id as string | number,
        ErrorCodes.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
};
