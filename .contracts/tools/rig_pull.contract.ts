import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const pullResult = z.object({
  nodeId: z.string(),
  score: z.number(),
  components: z.object({
    structural: z.number(),
    semantic: z.number(),
    recency: z.number(),
    hub: z.number(),
  }),
});

export default defineToolContract({
  name: 'rig_pull',
  tier: 'light',
  summary: 'Magnetic-pull ranking around an anchor',
  description: `
Rank the top-k anchors most "magnetically attracted" to the given node.
Score combines graph distance (structural), embedding cosine similarity
(semantic), recent activation decay (recency), and a hub-bias boost so
high-fanout anchors surface first by default. Returns PullResult[] with
{nodeId, score, components: {structural, semantic, recency, hub}}.

Use this for "what's related to X" or "what else should I look at" —
it is strictly better than rig_neighbors when you want a ranked list.
Use rig_neighbors only when you need the raw edge view. To disable the
hub bias (raw neighborhood ranking), pass hub_bias=0.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Anchor id to pull around'),
      k: z.number().int().min(1).max(100).default(10),
      hub_bias: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Additive boost for hub candidates (default 0.3). Pass 0 to disable.'),
    })
    .strict(),
  output: z.object({
    results: z.array(pullResult),
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
