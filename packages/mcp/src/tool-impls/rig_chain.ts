// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_chain.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.id)) throw new ToolError('NODE_NOT_FOUND', args.id);
  const chain = ctx.rig.getWaypointChain(args.id, args.max_depth);
  return { chain, elapsed_ms: Date.now() - start };
}
