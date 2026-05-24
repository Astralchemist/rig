import { Rig } from '@rig/core';
import { ToolError, makeActivationRecorder, type ToolContext, type ToolHandler } from './dispatch.ts';
import {
  buildHandlersMap,
  makeMessageHandler,
  type ToolsManifest,
} from './server-handlers.ts';
import { StdioTransport } from './transport.ts';
// Static imports so bun --compile bundles the generated artifacts into the binary.
// Dynamic file reads against import.meta.url break under $bunfs at runtime.
import manifestJson from '../../../generated/mcp/tools-manifest.json' with { type: 'json' };
import * as handlersModule from '../../../generated/mcp/handlers-index.ts';

export { ToolError, dispatchToolCall } from './dispatch.ts';
export type { ToolContext, ToolHandler } from './dispatch.ts';

const loadManifest = (): ToolsManifest => {
  const parsed = manifestJson as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { tools?: unknown }).tools)
  ) {
    throw new Error('Invalid bundled tools-manifest');
  }
  return parsed as ToolsManifest;
};

const loadHandlers = (): Map<string, ToolHandler> =>
  buildHandlersMap(handlersModule as unknown as Record<string, unknown>);

export interface ServeMcpOptions {
  projectRoot?: string;
}

export async function serveMcp(opts: ServeMcpOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const rig = await Rig.open(projectRoot);

  const manifest = loadManifest();
  const handlers = loadHandlers();

  // C4 — surface the AI's own skills as graph anchors. Idempotent on each
  // startup; descriptions stay in sync if contracts change between runs.
  rig.seedSkills(manifest.tools);

  const sessionId = crypto.randomUUID();
  const ctx: ToolContext = {
    rig,
    sessionId,
    // Phase 1 default: every connection IS the main session; subscribe lands later.
    isMainSession: true,
    // No writes in Phase 1, so provenance is always absent.
    provenance: null,
    recordActivation: makeActivationRecorder(rig, sessionId),
  };

  const transport = new StdioTransport();
  const handler = makeMessageHandler(transport, manifest, handlers, ctx);
  transport.start(handler);
}
