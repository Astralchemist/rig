// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const DEFAULT_PORT = 7474;
const FALLBACK_SPAN = 64;

const readConfig = (projectRoot: string): Record<string, unknown> => {
  const file = join(projectRoot, '.rig', 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// Port precedence: explicit flag → .rig/config.json → DEFAULT_PORT.
export const resolvePort = (projectRoot: string, explicit?: number): number => {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const fromCfg = readConfig(projectRoot).port;
  if (typeof fromCfg === 'number' && Number.isFinite(fromCfg)) return fromCfg;
  return DEFAULT_PORT;
};

// Project name for the title + /health: config first, then directory name.
export const resolveProjectName = (projectRoot: string): string => {
  const name = readConfig(projectRoot).name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return basename(projectRoot);
};

const isAddrInUse = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: string }).code === 'EADDRINUSE';

// Bind starting at `port`, walking forward up to +FALLBACK_SPAN when a port is
// already taken — so multiple projects (or a leftover server) never block start.
export const listenWithFallback = async (
  app: FastifyInstance,
  host: string,
  port: number,
): Promise<string> => {
  for (let p = port; p <= port + FALLBACK_SPAN; p++) {
    try {
      return await app.listen({ host, port: p });
    } catch (err) {
      if (isAddrInUse(err) && p < port + FALLBACK_SPAN) continue;
      throw err;
    }
  }
  throw new Error(`rig serve: no free port in ${port}–${port + FALLBACK_SPAN}`);
};
