// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/tools/rig_impact.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { ToolError } from '@rig/mcp/dispatch.ts';
import contract from '../../../.contracts/tools/rig_impact.contract.ts';
import { run as impl } from '@rig/mcp/tool-impls/rig_impact.ts';

export const rigImpactHandler: ToolHandler = {
  name: 'rig_impact',
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
