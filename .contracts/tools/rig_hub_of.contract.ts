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
  name: 'rig_hub_of',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Find the nearest hub(s) for a given anchor',
  description: `
Walk outward from an anchor via structural edges, return the first hub layer
reached (up to maxDepth hops). Use to answer "what part of the system does
this belong to" without traversing the full graph.
  `.trim(),
  input: z
    .object({
      id: z.string(),
      max_depth: z.number().int().min(1).max(6).default(3),
    })
    .strict(),
  output: z.object({
    hubs: z.array(hubRef),
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
