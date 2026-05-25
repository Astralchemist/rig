// SPDX-License-Identifier: Apache-2.0
type Ctx = Record<string, unknown> | undefined;

const emit = (level: 'debug' | 'warn', msg: string, ctx?: Ctx): void => {
  if (level === 'debug' && process.env.RIG_DEBUG !== '1') return;
  const line = ctx ? `${msg} ${JSON.stringify(ctx)}` : msg;
  // stderr only — stdout is reserved for MCP JSON-RPC frames.
  process.stderr.write(`[rig:${level}] ${line}\n`);
};

export const logDebug = (msg: string, ctx?: Ctx): void => emit('debug', msg, ctx);
export const logWarn = (msg: string, ctx?: Ctx): void => emit('warn', msg, ctx);
