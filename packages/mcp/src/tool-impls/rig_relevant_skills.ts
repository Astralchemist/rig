// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_relevant_skills.contract.ts';
import { queryHash, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const { skills, degraded } = await ctx.rig.getRelevantSkills(args.query, args.k);
  ctx.recordActivation(
    skills.map((s) => s.id),
    { queryHash: queryHash(args.query) },
  );
  return { skills, elapsed_ms: Date.now() - start, ...(degraded ? { degraded } : {}) };
}
