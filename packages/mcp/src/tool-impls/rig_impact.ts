import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_impact.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';
import { toNodeRef } from './_refs.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.id)) {
    throw new ToolError('NODE_NOT_FOUND', args.id);
  }
  ctx.recordActivation(args.id);
  return {
    nodes: ctx.rig.getImpactRadius(args.id, args.depth).map(toNodeRef),
    elapsed_ms: Date.now() - start,
  };
}
