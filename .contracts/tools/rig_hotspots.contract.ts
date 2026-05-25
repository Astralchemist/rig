// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const hotspot = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  touches: z.number().int(),
  unique_sessions: z.number().int(),
  last_ts: z.number().int(),
});

export default defineToolContract({
  name: 'rig_hotspots',
  tier: 'light',
  summary: 'Top nodes by recent activation count',
  description: `
Return the anchors that have been activated (queried, expanded, AI-touched)
most often within a sliding window. Count-based ranking — for decay-weighted
relevance use rig_pull.

Use to discover the parts of the graph you have been working in lately,
or to seed a cache-warming pass. Default window is 7 days, limit 20.
  `.trim(),
  input: z
    .object({
      window_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Lookback window in milliseconds. Default 7 days.'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({
    hotspots: z.array(hotspot),
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
