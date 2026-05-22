import type { ToolContext } from '../dispatch.ts';

export async function run(_args: unknown, ctx: ToolContext): Promise<{
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
  elapsed_ms: number;
}> {
  const start = Date.now();
  const s = await ctx.rig.status();
  return { ...s, elapsed_ms: Date.now() - start };
}
