import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig } from '@rig/core';
import { ToolError, makeActivationRecorder, type ToolContext, type ToolHandler } from './dispatch.ts';
import {
  buildHandlersMap,
  makeMessageHandler,
  type ToolsManifest,
} from './server-handlers.ts';
import { StdioTransport } from './transport.ts';

export { ToolError, dispatchToolCall } from './dispatch.ts';
export type { ToolContext, ToolHandler } from './dispatch.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/src → repo root → generated/mcp/{handlers-index.ts,tools-manifest.json}
const HANDLERS_INDEX_PATH = resolve(HERE, '../../../generated/mcp/handlers-index.ts');
const MANIFEST_PATH = resolve(HERE, '../../../generated/mcp/tools-manifest.json');

const loadManifest = async (): Promise<ToolsManifest> => {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { tools?: unknown }).tools)
  ) {
    throw new Error(`Invalid tools-manifest at ${MANIFEST_PATH}`);
  }
  return parsed as ToolsManifest;
};

const loadHandlers = async (): Promise<Map<string, ToolHandler>> => {
  const mod = (await import(HANDLERS_INDEX_PATH)) as Record<string, unknown>;
  return buildHandlersMap(mod);
};

export interface ServeMcpOptions {
  projectRoot?: string;
}

export async function serveMcp(opts: ServeMcpOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const rig = await Rig.open(projectRoot);

  const [manifest, handlers] = await Promise.all([loadManifest(), loadHandlers()]);

  const ctx: ToolContext = {
    rig,
    sessionId: crypto.randomUUID(),
    // Phase 1 default: every connection IS the main session; subscribe lands later.
    isMainSession: true,
    // No writes in Phase 1, so provenance is always absent.
    provenance: null,
    recordActivation: makeActivationRecorder(rig),
  };

  const transport = new StdioTransport();
  const handler = makeMessageHandler(transport, manifest, handlers, ctx);
  transport.start(handler);
}
