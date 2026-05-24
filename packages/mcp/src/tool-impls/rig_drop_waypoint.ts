import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_drop_waypoint.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const id = ctx.rig.writes.dropWaypoint(
    {
      kind: args.kind,
      title: args.title,
      summary: args.summary,
      ...(args.analogy ? { analogy: args.analogy } : {}),
      constellationRefs: args.constellation_refs,
      predecessors: args.predecessors,
      keyTerms: args.key_terms,
      compactable: args.compactable,
      payloads: args.payloads,
    },
    { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
  );
  return { id, elapsed_ms: Date.now() - start };
}
