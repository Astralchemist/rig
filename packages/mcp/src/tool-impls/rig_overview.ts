// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_overview.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const o = ctx.rig.overview(args.budget !== undefined ? { budget: args.budget } : {});
  return {
    map: o.map,
    generated_at: o.generated_at,
    nodes: o.nodes,
    elapsed_ms: Date.now() - start,
  };
}
