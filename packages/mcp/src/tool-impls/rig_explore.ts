// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_explore.contract.ts';
import type { ToolContext } from '../dispatch.ts';
import { readSnippet, viewOf } from './_snippet.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const hits = ctx.rig.searchNodes(args.question, { limit: args.max_anchors });
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
  return { anchors, elapsed_ms: Date.now() - start };
}
