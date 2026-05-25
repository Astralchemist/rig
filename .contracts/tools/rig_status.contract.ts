import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_status',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Report rig index health',
  description: `
Returns counts of nodes, edges, files, and the last sync timestamp.
Use as a smoke test before any other rig_* call to confirm the index is initialized.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    initialized: z.boolean(),
    nodes: z.number().int(),
    edges_structural: z.number().int(),
    edges_semantic: z.number().int(),
    files: z.number().int(),
    last_sync_ts: z.number().int().nullable(),
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
