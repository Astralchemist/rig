// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_deps.contract.ts';
import type { ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  return {
    deps: ctx.rig.getDependencies(args.manifest_path),
    elapsed_ms: Date.now() - start,
  };
}
