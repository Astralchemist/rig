// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_promote',
  tier: 'write',
  summary: 'Explicitly mark a node as a hub',
  description: `
Promote any node to hub status regardless of its fanout score. Used when the
user or AI has identified a concept-level anchor that the structural heuristic
missed (a "principle" waypoint, a domain entity, a documentation root).

Hubs surface in rig_hubs results and bias rig_pull rankings.
  `.trim(),
  input: z
    .object({
      id: z.string(),
      rationale: z.string().min(10, 'rationale must be at least 10 characters'),
    })
    .strict(),
  output: z.object({
    promoted: z.boolean(),
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
  records_activation: false,
  provenance_required: true,
  requires_rationale: true,
  broadcasts: 'node:promoted',
});
