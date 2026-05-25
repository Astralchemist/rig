import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const step = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  hubness: z.number(),
  activation_count: z.number().int(),
  step_weight: z.number(),
});

export default defineToolContract({
  name: 'rig_critical_path',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: "Walk the architecture's spine from a root anchor",
  description: `
Greedy walk outward from the root anchor, picking the highest-scoring outbound
edge at each step. Score = w_hubness × destination.hubness + w_activation ×
normalized_activation_count + w_kind × edge_kind_weight (contains > references
> calls > imports). Returns an ordered chain — the "main thread" through the
subsystem rooted at this anchor.

Use as a one-shot architecture tour: "what's the spine of this code path"
or "which chain of anchors carries the most traffic from X". For one-hop
neighbors use rig_neighbors; for ranked similarity use rig_pull.
  `.trim(),
  input: z
    .object({
      id: z.string(),
      max_steps: z.number().int().min(2).max(32).default(12),
    })
    .strict(),
  output: z.object({
    path: z.array(step),
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
