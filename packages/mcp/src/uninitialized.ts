// SPDX-License-Identifier: Apache-2.0
import type { Rig } from '@rig/core';
import { ToolError, type ToolContext, type ToolHandler } from './dispatch.ts';
import { makeMessageHandler, type ToolsManifest } from './server-handlers.ts';
import { StdioTransport } from './transport.ts';

export const notInitializedError = (projectRoot: string): ToolError =>
  new ToolError(
    'NOT_INITIALIZED',
    `rig is not initialised in ${projectRoot} (no .rig/ graph there). ` +
      'Run `rig init` in that directory — or `rig start` to initialise, index and open the map — ' +
      'then restart this MCP server.',
    { projectRoot, fix: ['rig init', 'rig start'] },
  );

// Every tool in the manifest, each answering NOT_INITIALIZED.
export const uninitializedHandlers = (
  manifest: ToolsManifest,
  projectRoot: string,
): Map<string, ToolHandler> =>
  new Map(
    manifest.tools.map((t): [string, ToolHandler] => [
      t.name,
      {
        name: t.name,
        tier: t.tier as ToolHandler['tier'],
        run: async () => {
          throw notInitializedError(projectRoot);
        },
      },
    ]),
  );

// No graph behind it: anything that reaches for ctx.rig gets the same error.
const uninitializedContext = (projectRoot: string): ToolContext => ({
  get rig(): Rig {
    throw notInitializedError(projectRoot);
  },
  sessionId: crypto.randomUUID(),
  provenance: null,
  recordActivation: () => {},
});

// Outside an initialised project the server still starts, so the MCP host
// sees a healthy server: initialize and tools/list answer as usual and every
// tool call returns a structured NOT_INITIALIZED error naming the fix.
export const serveUninitialized = (projectRoot: string, manifest: ToolsManifest): void => {
  process.stderr.write(
    `rig: no .rig/ in ${projectRoot} — tool calls will answer NOT_INITIALIZED until you run \`rig init\` there\n`,
  );
  const transport = new StdioTransport();
  transport.start(
    makeMessageHandler(
      transport,
      manifest,
      uninitializedHandlers(manifest, projectRoot),
      uninitializedContext(projectRoot),
    ),
  );
};
