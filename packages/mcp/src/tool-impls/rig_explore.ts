// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_explore.contract.ts';
import { queryHash, type ToolContext } from '../dispatch.ts';
import { fitSources } from './_budget.ts';
import { readSnippet, viewOf } from './_snippet.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const hits = ctx.rig.searchNodes(args.question, { limit: args.max_anchors });
  ctx.recordActivation(
    hits.map((n) => n.id),
    { queryHash: queryHash(args.question) },
  );
  const anchors = await Promise.all(
    hits.map(async (n) => {
      const v = viewOf(n);
      const source = await readSnippet(ctx.rig.projectRoot, v);
      const callers = ctx.rig
        .getCallers(n.id)
        .slice(0, 3)
        .map((c) => ({ id: c.id, name: c.name, kind: c.type }));
      const callees = ctx.rig
        .getCallees(n.id)
        .slice(0, 3)
        .map((c) => ({ id: c.id, name: c.name, kind: c.type }));
      return { ...v, source, related: [...callers, ...callees] };
    }),
  );
  // Trim source bodies (never whole anchors) so the response stays under the
  // client's tool-response cap.
  const { items, truncated } = fitSources(anchors, (as) =>
    JSON.stringify({ anchors: as, elapsed_ms: 0, truncated: true }),
  );
  return { anchors: items, elapsed_ms: Date.now() - start, truncated };
}
