// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { trustTier } from '@rig/core/memory/shared.ts';
import type { WaypointRow } from '@rig/core/db/waypoint-queries.ts';
import contract from '../../../../.contracts/tools/rig_waypoints.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

// Every waypoint says how far to trust it (B5); records teammates shared that
// reviewers mostly marked outdated are left out unless asked for.
const withTrust = (rows: WaypointRow[], includeDisputed: boolean) =>
  rows
    .map((w) => ({ ...w, trust: trustTier(w) }))
    .filter((w) => includeDisputed || w.trust !== 'disputed');

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const opts = {
    ...(args.session_id ? { sessionId: args.session_id } : {}),
    callerSessionId: ctx.sessionId,
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
  const disputed = args.include_disputed === true;
  if (args.query) {
    const { waypoints, degraded } = await ctx.rig.searchWaypoints(args.query, opts);
    return {
      waypoints: withTrust(waypoints, disputed),
      elapsed_ms: Date.now() - start,
      ...(degraded ? { degraded } : {}),
    };
  }
  return {
    waypoints: withTrust(ctx.rig.getWaypoints(opts), disputed),
    elapsed_ms: Date.now() - start,
  };
}
