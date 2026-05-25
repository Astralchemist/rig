// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_add_node',
  tier: 'write',
  summary: 'Add a new anchor extracted from conversation',
  description: `
Create a new anchor immediately (nodes are cheaper to add than edges).
Use only when the user has explicitly named a new concept in
conversation; do not invent anchors from inference alone.
  `.trim(),
  input: z
    .object({
      type: z.string().min(1),
      name: z.string().min(1),
      data: z.record(z.string(), z.unknown()).default({}),
      rationale: z.string().min(10),
    })
    .strict(),
  output: z.object({
    id: z.string(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'PROVENANCE_REQUIRED', 'RATIONALE_REQUIRED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
  provenance_required: true,
  requires_rationale: true,
  broadcasts: 'node:added',
});
