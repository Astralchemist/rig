import type { Rig } from '@rig/core';

export interface ToolContext {
  rig: Rig;
  sessionId: string;
  isMainSession: boolean;
  provenance: string | null;
}

export interface ToolHandler {
  name: string;
  tier: 'light' | 'heavy' | 'write' | 'live';
  mainSessionForbidden?: boolean;
  provenanceRequired?: boolean;
  requiresRationale?: boolean;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
