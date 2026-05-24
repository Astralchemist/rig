import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_cold.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const cold = ctx.rig.getCold({
    ...(args.stale_after_ms !== undefined ? { staleAfterMs: args.stale_after_ms } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return { cold, elapsed_ms: Date.now() - start };
}
