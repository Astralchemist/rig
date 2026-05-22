import type { ToolContext } from '../dispatch.ts';

export async function run(_args: unknown, _ctx: ToolContext): Promise<{
  initialized: boolean;
  nodes: number;
  edges_structural: number;
  edges_semantic: number;
  files: number;
  last_sync_ts: number | null;
  elapsed_ms: number;
}> {
  const start = Date.now();
  // Phase 0 stub: real implementation lands in Phase 1 against an open Rig.
  return {
    initialized: false,
    nodes: 0,
    edges_structural: 0,
    edges_semantic: 0,
    files: 0,
    last_sync_ts: null,
    elapsed_ms: Date.now() - start,
  };
}
