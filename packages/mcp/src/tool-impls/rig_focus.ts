import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_focus.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  ctx.rig.writes.recordFocus(args.node_ids, {
    sessionId: ctx.sessionId,
    actor: ctx.provenance ?? 'ai:unknown',
  });
  return { ok: true, elapsed_ms: Date.now() - start };
}
