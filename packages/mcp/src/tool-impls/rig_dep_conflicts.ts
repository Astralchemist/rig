import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_dep_conflicts.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Result = z.infer<typeof contract.output>;

export async function run(_args: unknown, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  return {
    conflicts: ctx.rig.getDependencyConflicts(),
    elapsed_ms: Date.now() - start,
  };
}
