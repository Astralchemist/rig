import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_subscribe.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const events = ctx.rig.writes.mutationsSince(args.since_ts, args.session_id);
  const next_cursor =
    events.length > 0
      ? Math.max(...events.map((e) => e.ts))
      : args.since_ts;
  return {
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      session_id: e.session_id,
      kind: e.kind,
      payload: e.payload,
      actor: e.actor,
    })),
    next_cursor,
    elapsed_ms: Date.now() - start,
  };
}
