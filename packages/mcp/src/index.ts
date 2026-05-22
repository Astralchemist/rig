export { ToolError } from './dispatch.ts';
export type { ToolContext, ToolHandler } from './dispatch.ts';

// Phase 1 will wire the MCP stdio transport here and dispatch via the
// generated handlers in generated/mcp/handlers-index.ts.
export async function serveMcp(): Promise<void> {
  throw new Error('MCP server not implemented yet (Phase 1)');
}
