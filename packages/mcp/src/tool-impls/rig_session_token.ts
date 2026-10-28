// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { readWebAddress } from '@rig/core/web-address.ts';
import contract from '../../../../.contracts/tools/rig_session_token.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

// Only used when no web server has recorded where it bound.
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7474;

// IPv6 literals need brackets inside a URL.
const urlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const path = join(ctx.rig.projectRoot, '.rig', '.runtime');
  if (!existsSync(path)) {
    throw new ToolError(
      'NO_RUNTIME_TOKEN',
      'No map token yet (.rig/.runtime missing). Start the map with `rig start` or `rig serve --web`.',
    );
  }
  const token = readFileSync(path, 'utf-8').trim();
  if (token.length < 32) throw new ToolError('NO_RUNTIME_TOKEN', 'runtime token is malformed');
  // Web ports are per project, so prefer the address the server recorded when
  // it bound; explicit args still win.
  const bound = readWebAddress(ctx.rig.projectRoot);
  const host = args.host ?? bound?.host ?? DEFAULT_HOST;
  const port = args.port ?? bound?.port ?? DEFAULT_PORT;
  const url = `http://${urlHost(host)}:${port}/auth?t=${token}`;
  return { token, login_url: url, elapsed_ms: Date.now() - start };
}
