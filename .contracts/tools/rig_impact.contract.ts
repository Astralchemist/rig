import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const nodeRef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string().optional(),
});

export default defineToolContract({
  name: 'rig_impact',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Transitive impact radius of an anchor',
  description: `
Return all anchors reachable as transitive callers of the given anchor
up to the requested depth. Useful for change-impact analysis: "if I
change this function, what tests/callers might break".

Defaults to depth 3. Depth is capped at 6 to keep the result bounded.
For one-hop callers use rig_callers.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Anchor id to compute impact from'),
      depth: z.number().int().min(1).max(6).default(3),
    })
    .strict(),
  output: z.object({
    nodes: z.array(nodeRef),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND', 'DEPTH_OUT_OF_RANGE'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
});
