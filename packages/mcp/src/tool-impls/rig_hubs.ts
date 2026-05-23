import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_hubs.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const hubs = ctx.rig.getTopHubs({ scope: args.scope, limit: args.limit });
  return {
    hubs: hubs.map((h) => ({
      id: h.id,
      name: h.name,
      kind: h.type,
      hubness: h.hubness,
      explicit: h.explicit,
    })),
    elapsed_ms: Date.now() - start,
  };
}
