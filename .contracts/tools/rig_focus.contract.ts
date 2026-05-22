import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_focus',
  tier: 'write',
  summary: 'Ask the UI to focus on a set of anchors',
  description: `
Emit a focus:requested event over WebSocket so the map UI pans and
zooms to the given anchors. No graph mutation; logged in mutation_log
for audit.
  `.trim(),
  input: z
    .object({
      node_ids: z.array(z.string().min(1)).min(1).max(20),
    })
    .strict(),
  output: z.object({
    ok: z.boolean(),
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
  broadcasts: 'focus:requested',
});
