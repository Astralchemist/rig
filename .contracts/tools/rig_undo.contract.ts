// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_undo',
  tier: 'write',
  summary: 'Reverse the last mutation in this session',
  description: `
Walk back the most recent mutation in the current MCP session — propose
becomes deleted, accept becomes pending again, reject becomes pending,
add_node deletes the node. Undos are themselves logged; the chain is
auditable.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    undone: z
      .object({
        id: z.number().int(),
        kind: z.string(),
        ts: z.number().int(),
      })
      .nullable(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'PROVENANCE_REQUIRED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
  provenance_required: true,
});
