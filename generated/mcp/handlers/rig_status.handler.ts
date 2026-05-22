// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/tools/rig_status.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { run as impl } from '@rig/mcp/tool-impls/rig_status.ts';

export const rigStatusHandler: ToolHandler = {
  name: 'rig_status',
  tier: 'light',
  run: impl,
};
