import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const drillResult = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  depth: z.number().int(),
  pull_score: z.number(),
});

export default defineToolContract({
  name: 'rig_drill',
  tier: 'light',
  summary: "Explore a hub's sub-tree, ranked by magnetic pull",
  description: `
Walk outward from a hub via structural edges (contains > references > calls >
imports), rank descendants by magnetic pull from the hub. Optional name query
filters the returned set. Use after rig_hubs to drill into one part of the
graph instead of dumping the whole neighborhood.
  `.trim(),
  input: z
    .object({
      hub_id: z.string(),
      query: z.string().optional(),
      max_depth: z.number().int().min(1).max(6).default(3),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  output: z.object({
    results: z.array(drillResult),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
});
