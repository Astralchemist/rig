// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_aliases.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  if (!ctx.rig.getNode(args.id)) throw new ToolError('NODE_NOT_FOUND', args.id);
  ctx.recordActivation(args.id);
  const rows = ctx.rig.getAliases(args.id);
  return {
    aliases: rows.map((r) => ({
      alias: r.alias,
      provenance: r.provenance,
      rationale: r.rationale,
      created_at: r.created_at,
    })),
    elapsed_ms: Date.now() - start,
  };
}
