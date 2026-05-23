import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_add_alias.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.id)) throw new ToolError('NODE_NOT_FOUND', args.id);
  const added = ctx.rig.writes.addAlias(
    { nodeId: args.id, alias: args.alias, rationale: args.rationale },
    { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
  );
  return { added, elapsed_ms: Date.now() - start };
}
