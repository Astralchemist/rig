import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_propose_edge.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.src)) throw new ToolError('NODE_NOT_FOUND', args.src);
  if (!ctx.rig.getNode(args.dst)) throw new ToolError('NODE_NOT_FOUND', args.dst);
  const pendingId = ctx.rig.writes.proposeEdge(
    { ...args, sourceUrls: args.source_urls },
    { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
  );
  return { pending_id: pendingId, elapsed_ms: Date.now() - start };
}
