// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_annotate.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const ok = ctx.rig.writes.annotateNode(
    { nodeId: args.node_id, note: args.note, rationale: args.rationale },
    { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
  );
  if (!ok) throw new ToolError('NODE_NOT_FOUND', args.node_id);
  ctx.recordActivation(args.node_id);
  return { ok: true, elapsed_ms: Date.now() - start };
}
