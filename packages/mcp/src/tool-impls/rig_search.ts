// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_search.contract.ts';
import { queryHash, type ToolContext } from '../dispatch.ts';
import { toNodeRef } from './_refs.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

// Scores are RRF sums (~0.01–0.1); six decimals keep their order.
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const { hits, degraded } = await ctx.rig.search(args.query, {
    ...(args.kind ? { kinds: [args.kind] } : {}),
    limit: args.limit,
  });
  ctx.recordActivation(
    hits.map((h) => h.node.id),
    { queryHash: queryHash(args.query) },
  );
  return {
    nodes: hits.map((h) => ({
      ...toNodeRef(h.node),
      score: round(h.score),
      matched_by: h.matchedBy,
    })),
    elapsed_ms: Date.now() - start,
    ...(degraded ? { degraded } : {}),
  };
}
