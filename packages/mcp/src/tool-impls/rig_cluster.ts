import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_cluster.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  for (const id of args.node_ids) {
    if (!ctx.rig.getNode(id)) throw new ToolError('NODE_NOT_FOUND', id);
  }
  const cluster_id = ctx.rig.writes.clusterNodes(
    { memberIds: args.node_ids, label: args.label, rationale: args.rationale },
    { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
  );
  return { cluster_id, elapsed_ms: Date.now() - start };
}
