// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { UnknownRefsError } from '@rig/core';
import contract from '../../../../.contracts/tools/rig_drop_waypoint.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  let id: string;
  try {
    id = ctx.rig.writes.dropWaypoint(
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
        rationale: args.rationale,
      },
      { sessionId: ctx.sessionId, actor: ctx.provenance ?? 'ai:unknown' },
    );
  } catch (e) {
    if (!(e instanceof UnknownRefsError)) throw e;
    throw new ToolError('NODE_NOT_FOUND', e.message, {
      unknown_ids: e.unknownIds,
      constellation_refs: e.constellationRefs,
      predecessors: e.predecessors,
    });
  }
  return { id, elapsed_ms: Date.now() - start };
}
