// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_critical_path.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.id)) throw new ToolError('NODE_NOT_FOUND', args.id);
  ctx.recordActivation(args.id);
  const path = ctx.rig.getCriticalPath(args.id, args.max_steps);
  return {
    path: path.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.type,
      hubness: p.hubness,
      activation_count: p.activation_count,
      step_weight: p.step_weight,
    })),
    elapsed_ms: Date.now() - start,
  };
}
