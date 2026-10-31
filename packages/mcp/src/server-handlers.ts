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

export const buildHandlersMap = (exports: Record<string, unknown>): Map<string, ToolHandler> => {
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

// One static resource for now. Shapes follow the MCP resources spec
// (2025-06-18): resources/list → { resources: Resource[] }, resources/read →
// { contents: [{ uri, mimeType, text }] }, an unknown URI → -32002. The
// protocol version answered stays 2024-11-05, whose resource shapes are the
// same minus `title`; a client ignores fields it does not know.
export interface ResourceDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  read(ctx: ToolContext): string | Promise<string>;
}

export const RESOURCES: readonly ResourceDef[] = [
  {
    uri: 'rig://overview',
    name: 'overview',
    title: 'Repository overview',
    description:
      'Compact markdown map of this repository (about 2,000 tokens): packages, entry points, ' +
      'key files and symbols with file:line, handler surfaces, tests and recent decisions. ' +
      'The same map rig_overview returns; read it at the start of a session.',
    mimeType: 'text/markdown',
    read: (ctx) => ctx.rig.overview().map,
  },
];

// Protocol versions rig speaks, newest first. A client asking for one of
// these gets it; anything else gets the newest (MCP version negotiation).
// Every version gets the same results: structuredContent and isError are
// additive, and annotations are ignored by clients that predate them.
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const negotiateProtocol = (requested: unknown): string =>
  typeof requested === 'string' && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOLS[0];

const serverInfo = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: { tools: {}, resources: {} },
  serverInfo: { name: 'rig', version: (pkg as { version: string }).version },
});

// Tool annotations (MCP 2025-03-26): hints for the client's approval UI.
// Reads never change anything; writes change only rig's own memory, and only
// rig_undo takes something away. Rig never reaches the network.
export const toolAnnotations = (t: ToolManifestEntry) => ({
  readOnlyHint: t.tier !== 'write',
  destructiveHint: t.name === 'rig_undo',
  idempotentHint: t.tier !== 'write',
  openWorldHint: false,
});

// Tool errors a caller can act on come back as results with isError, so the
// model sees them (MCP: execution errors belong in the result); an unknown
// tool stays a protocol error.
// NOT_INITIALIZED is a server state, not a tool failure, and its data (the
// directory and the fix) is for the host, so it stays a protocol error too.
const PROTOCOL_ERRORS = new Set(['TOOL_NOT_FOUND', 'NOT_INITIALIZED']);

const isParams = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const handleToolsCall = async (
  params: unknown,
  ctx: ToolContext,
  handlers: Map<string, ToolHandler>,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> => {
  const p = isParams(params) ? params : {};
  const name = typeof p.name === 'string' ? p.name : '';
  const args = p.arguments;
  try {
    const result = await dispatchToolCall(name, args, ctx, handlers);
    // Every tool declares an outputSchema, so the result also goes out as
    // structuredContent (MCP 2025-06-18); the text copy serves older clients.
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(isParams(result) && !Array.isArray(result)
        ? { structuredContent: result as Record<string, unknown> }
        : {}),
    };
  } catch (err) {
    if (err instanceof ToolError && !PROTOCOL_ERRORS.has(err.code)) {
      return {
        content: [{ type: 'text', text: `${err.code}: ${err.message}` }],
        isError: true,
      };
    }
    throw err;
  }
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
        transport.sendResult(
          id as string | number,
          serverInfo(negotiateProtocol(isParams(params) ? params.protocolVersion : undefined)),
        );
        return;
      }
      if (method === 'tools/list') {
        transport.sendResult(id as string | number, {
          tools: manifest.tools.map((t) => ({ ...t, annotations: toolAnnotations(t) })),
        });
        return;
      }
      if (method === 'resources/list') {
        transport.sendResult(id as string | number, {
          resources: RESOURCES.map(({ uri, name, title, description, mimeType }) => ({
            uri,
            name,
            title,
            description,
            mimeType,
          })),
        });
        return;
      }
      if (method === 'resources/templates/list') {
        transport.sendResult(id as string | number, { resourceTemplates: [] });
        return;
      }
      if (method === 'resources/read') {
        const params = (message as JsonRpcRequest).params;
        const uri = isParams(params) && typeof params.uri === 'string' ? params.uri : '';
        const resource = RESOURCES.find((r) => r.uri === uri);
        if (!resource) {
          transport.sendError(
            id as string | number,
            ErrorCodes.ResourceNotFound,
            `Resource not found: ${uri}`,
            { uri },
          );
          return;
        }
        const text = await resource.read(ctx);
        transport.sendResult(id as string | number, {
          contents: [{ uri, mimeType: resource.mimeType, text }],
        });
        return;
      }
      if (method === 'tools/call') {
        const result = await handleToolsCall((message as JsonRpcRequest).params, ctx, handlers);
        transport.sendResult(id as string | number, result);
        return;
      }
      transport.sendError(
        id as string | number,
        ErrorCodes.MethodNotFound,
        `Method not found: ${method}`,
      );
    } catch (err) {
      if (err instanceof ToolError) {
        transport.sendError(id as string | number, ErrorCodes.InternalError, err.message, {
          ...err.data,
          rigError: err.code,
        });
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
