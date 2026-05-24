import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_hotspots.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const hotspots = ctx.rig.getHotspots({
    ...(args.window_ms !== undefined ? { windowMs: args.window_ms } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return { hotspots, elapsed_ms: Date.now() - start };
}
