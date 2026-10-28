// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const mutationRef = z.object({
  id: z.number().int(),
  kind: z.string(),
  ts: z.number().int(),
});

export default defineToolContract({
  name: 'rig_undo',
  tier: 'write',
  summary: 'Reverse the last mutation in this session',
  description: `
Walk back the most recent mutation in the current MCP session that has not
been undone yet; call it again to step further back. A proposal is deleted,
an accept or reject returns the edge to pending, add_node, cluster and
drop_waypoint delete what they created, add_alias and annotate remove the
alias or note, and promote restores the node's previous hub flags. Undos
are themselves logged; the chain is auditable.

undone is the mutation reverted, or null when nothing was. Then reason
says why: "nothing to undo" when the session has no mutation left, or why
the inverse of the mutation named in failed can no longer be applied (its
target is gone, or was changed since). A failed mutation is not retried:
the next call moves on to the one before it.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    undone: mutationRef.nullable(),
    reason: z.string().optional().describe('Why nothing was undone'),
    failed: mutationRef.optional().describe('The mutation whose inverse could not be applied'),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'PROVENANCE_REQUIRED'],
  permissions: {
    claude: 'ask',
    cursor: 'ask',
    codex: 'ask',
    opencode: 'ask',
    openrouter: 'ask',
  },
  records_activation: false,
  provenance_required: true,
});
