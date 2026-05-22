import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_search.contract.ts';
import type { ToolContext } from '../dispatch.ts';
import { toNodeRef } from './_refs.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const nodes = ctx.rig.searchNodes(args.query, {
    kind: args.kind,
    limit: args.limit,
  });
  return {
    nodes: nodes.map(toNodeRef),
    elapsed_ms: Date.now() - start,
  };
}
