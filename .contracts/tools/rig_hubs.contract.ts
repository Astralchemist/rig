// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const hubRef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  hubness: z.number(),
  explicit: z.boolean(),
});

export default defineToolContract({
  name: 'rig_hubs',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'List top hubs by hubness score',
  description: `
Return the most "hub-like" anchors in the graph, ranked by hubness. Hubs are
high-fanout structural concentrations (top 5% per anchor type) plus any node
explicitly promoted via rig_promote.

Use as the entry point when navigating a large graph — pick a hub, then call
rig_drill to explore its sub-tree.
  `.trim(),
  input: z
    .object({
      scope: z.string().optional().describe('Filter by anchor kind (e.g. file, module)'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({
    hubs: z.array(hubRef),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
