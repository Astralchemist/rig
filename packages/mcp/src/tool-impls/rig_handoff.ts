// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { readHandoff, writeHandoff, type Handoff } from '@rig/core/handoff/handoff.ts';
import contract from '../../../../.contracts/tools/rig_handoff.contract.ts';
import { ToolError, type ToolContext } from '../dispatch.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

const view = (h: Handoff | null): Result['handoff'] =>
  h
    ? {
        written_at: h.written_at,
        branch: h.branch,
        commit: h.commit,
        client: h.client,
        source: h.source,
        ...(h.goal ? { goal: h.goal } : {}),
        current_work: h.current_work,
        pending: h.pending,
        ...(h.next_step ? { next_step: h.next_step } : {}),
        files: h.files,
        consumed: !!h.consumed_by,
      }
    : null;

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const root = ctx.rig.projectRoot;
  if (args.action === 'read')
    return { handoff: view(readHandoff(root)), elapsed_ms: Date.now() - start };
  if (!args.current_work?.trim())
    throw new ToolError('INVALID_ARGS', 'current_work is required to write a handoff');
  const h = writeHandoff(
    root,
    {
      session_id: ctx.sessionId,
      client: ctx.provenance?.replace(/^ai:/, '') ?? 'agent',
      source: 'agent',
      current_work: args.current_work,
      ...(args.goal ? { goal: args.goal } : {}),
      ...(args.pending ? { pending: args.pending } : {}),
      ...(args.next_step ? { next_step: args.next_step } : {}),
      ...(args.files ? { files: args.files } : {}),
    },
    { force: args.force === true },
  );
  if (!h)
    throw new ToolError(
      'HANDOFF_LIVE',
      "Another session's handoff here is unconsumed and less than two hours old; pass force: true to replace it.",
    );
  return { handoff: view(h), elapsed_ms: Date.now() - start };
}
