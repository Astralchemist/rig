// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/tools/rig_unused_deps.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { ToolError } from '@rig/mcp/dispatch.ts';
import contract from '../../../.contracts/tools/rig_unused_deps.contract.ts';
import { run as impl } from '@rig/mcp/tool-impls/rig_unused_deps.ts';

export const rigUnusedDepsHandler: ToolHandler = {
  name: 'rig_unused_deps',
  tier: 'light',
  run: async (args, ctx) => {
    const parsedIn = contract.input.safeParse(args);
    if (!parsedIn.success) {
      throw new ToolError('INPUT_INVALID', parsedIn.error.message);
    }
    const out = await impl(parsedIn.data, ctx);
    const parsedOut = contract.output.safeParse(out);
    if (!parsedOut.success) {
      throw new ToolError('OUTPUT_INVALID', parsedOut.error.message);
    }
    return parsedOut.data;
  },
};
