import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const coldNode = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  last_ts: z.number().int().nullable(),
});

export default defineToolContract({
  name: 'rig_cold',
  tier: 'light',
  summary: 'Nodes not touched in a long time (or ever)',
  description: `
Return the anchors that have not been activated within the stale-after
window. last_ts is null when the node has never been touched. Useful for
pruning candidates and identifying dead-weight in the graph.

Default stale-after is 90 days, limit 20.
  `.trim(),
  input: z
    .object({
      stale_after_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('A node is "cold" if its most recent touch is older than this. Default 90 days.'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({
    cold: z.array(coldNode),
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
