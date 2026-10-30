// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_waypoints.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const opts = {
    ...(args.session_id ? { sessionId: args.session_id } : {}),
    callerSessionId: ctx.sessionId,
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
  if (args.query) {
    const { waypoints, degraded } = await ctx.rig.searchWaypoints(args.query, opts);
    return { waypoints, elapsed_ms: Date.now() - start, ...(degraded ? { degraded } : {}) };
  }
  return { waypoints: ctx.rig.getWaypoints(opts), elapsed_ms: Date.now() - start };
}
