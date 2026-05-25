// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_undo.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(_args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const undone = ctx.rig.writes.undoLast({
    sessionId: ctx.sessionId,
    actor: ctx.provenance ?? 'ai:unknown',
  });
  return {
    undone: undone ? { id: undone.id, kind: undone.kind, ts: undone.ts } : null,
    elapsed_ms: Date.now() - start,
  };
}
