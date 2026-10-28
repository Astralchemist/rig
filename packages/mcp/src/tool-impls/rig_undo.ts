// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_undo.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(_args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const r = ctx.rig.writes.undo({
    sessionId: ctx.sessionId,
    actor: ctx.provenance ?? 'ai:unknown',
  });
  const ref = r.mutation ? { id: r.mutation.id, kind: r.mutation.kind, ts: r.mutation.ts } : null;
  if (r.undone) return { undone: ref, elapsed_ms: Date.now() - start };
  return {
    undone: null,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(ref ? { failed: ref } : {}),
    elapsed_ms: Date.now() - start,
  };
}
