import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_node.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const node = ctx.rig.getNode(args.id);
  if (!node) throw new ToolError('NODE_NOT_FOUND', args.id);
  ctx.recordActivation(args.id);
  const data = node.data;
  const counts = ctx.rig.getNeighborCounts(args.id);
  return {
    id: node.id,
    name: node.name,
    kind: node.type,
    ...(optStr(data.filePath) !== undefined ? { file_path: optStr(data.filePath)! } : {}),
    ...(optStr(data.qualifiedName) !== undefined
      ? { qualified_name: optStr(data.qualifiedName)! }
      : {}),
    ...(optStr(data.signature) !== undefined ? { signature: optStr(data.signature)! } : {}),
    ...(optStr(data.docstring) !== undefined ? { docstring: optStr(data.docstring)! } : {}),
    neighbor_counts: counts,
    elapsed_ms: Date.now() - start,
  };
}
