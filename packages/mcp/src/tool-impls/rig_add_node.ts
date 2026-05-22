import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_add_node.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const id = ctx.rig.writes.addNode(args, {
    sessionId: ctx.sessionId,
    actor: ctx.provenance ?? 'ai:unknown',
  });
  return { id, elapsed_ms: Date.now() - start };
}
