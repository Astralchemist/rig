// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_session_token.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

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
  const url = `http://${args.host}:${args.port}/auth?t=${token}`;
  return { token, login_url: url, elapsed_ms: Date.now() - start };
}
