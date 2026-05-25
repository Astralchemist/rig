// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_annotate',
  tier: 'write',
  summary: 'Append a note to an anchor',
  description: `
Append a free-text note to a node's data.annotations array. Useful for
the AI to leave a breadcrumb on a node ("this is the auth boundary",
"renamed from FooBar in commit abc1234").
  `.trim(),
  input: z
    .object({
      node_id: z.string(),
      note: z.string().min(1),
      rationale: z.string().min(10),
    })
    .strict(),
  output: z.object({
    ok: z.boolean(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND', 'PROVENANCE_REQUIRED', 'RATIONALE_REQUIRED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
  provenance_required: true,
  requires_rationale: true,
});
