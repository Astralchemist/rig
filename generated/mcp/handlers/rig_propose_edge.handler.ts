// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/tools/rig_propose_edge.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

import type { ToolHandler } from '@rig/mcp/dispatch.ts';
import { ToolError } from '@rig/mcp/dispatch.ts';
import contract from '../../../.contracts/tools/rig_propose_edge.contract.ts';
import { run as impl } from '@rig/mcp/tool-impls/rig_propose_edge.ts';

export const rigProposeEdgeHandler: ToolHandler = {
  name: 'rig_propose_edge',
  tier: 'write',
  provenanceRequired: true,
  requiresRationale: true,
  run: async (args, ctx) => {
    if (!ctx.provenance) {
      throw new ToolError('PROVENANCE_REQUIRED', 'rig_propose_edge requires provenance');
    }
    const parsedIn = contract.input.safeParse(args);
    if (!parsedIn.success) {
      throw new ToolError('INPUT_INVALID', parsedIn.error.message);
    }
    const rationale = (parsedIn.data as { rationale?: unknown }).rationale;
    if (typeof rationale !== 'string' || rationale.trim().length === 0) {
      throw new ToolError('RATIONALE_REQUIRED', 'rig_propose_edge requires a non-empty rationale');
    }
    const out = await impl(parsedIn.data, ctx);
    const parsedOut = contract.output.safeParse(out);
    if (!parsedOut.success) {
      throw new ToolError('OUTPUT_INVALID', parsedOut.error.message);
    }
    return parsedOut.data;
  },
};
