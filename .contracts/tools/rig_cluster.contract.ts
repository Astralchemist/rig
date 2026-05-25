// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_cluster',
  tier: 'write',
  summary: 'Create a cluster meta-anchor over existing anchors',
  description: `
Create a new node of type 'cluster' with 'contains' edges to each member.
The cluster becomes its own searchable anchor. Use when you spot a
group of related anchors that deserves a name.
  `.trim(),
  input: z
    .object({
      node_ids: z.array(z.string().min(1)).min(2),
      label: z.string().min(1),
      rationale: z.string().min(10),
    })
    .strict(),
  output: z.object({
    cluster_id: z.string(),
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
  broadcasts: 'node:added',
});
