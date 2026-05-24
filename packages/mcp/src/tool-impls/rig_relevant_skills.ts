import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_relevant_skills.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  return {
    skills: ctx.rig.getRelevantSkills(args.query, args.k),
    elapsed_ms: Date.now() - start,
  };
}
