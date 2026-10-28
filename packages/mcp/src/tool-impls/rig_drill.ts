// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_drill.contract.ts';
import { ToolError, queryHash, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.hub_id)) throw new ToolError('NODE_NOT_FOUND', args.hub_id);
  ctx.recordActivation(
    args.hub_id,
    args.query !== undefined ? { queryHash: queryHash(args.query) } : {},
  );
  const results = ctx.rig.drillFromHub(args.hub_id, {
    ...(args.query !== undefined ? { query: args.query } : {}),
    maxDepth: args.max_depth,
    limit: args.limit,
  });
  return {
    results: results.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.type,
      depth: r.depth,
      pull_score: r.pull_score,
    })),
    elapsed_ms: Date.now() - start,
  };
}
