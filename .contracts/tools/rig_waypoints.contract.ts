import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const waypoint = z.object({
  id: z.string(),
  ts: z.number().int(),
  session_id: z.string(),
  kind: z.enum(['decision', 'observation', 'constraint', 'open-question', 'principle']),
  title: z.string(),
  summary: z.string(),
  analogy: z.string().nullable(),
  constellation_refs: z.array(z.string()),
  predecessors: z.array(z.string()),
  key_terms: z.array(z.string()),
  compactable: z.boolean(),
});

export default defineToolContract({
  name: 'rig_waypoints',
  tier: 'light',
  summary: 'List conversation waypoints by session or kind',
  description: `
List waypoints in newest-first order. Optional filters: session_id (pass
"last" to auto-resolve to the most-recently-active session — useful at
session start to rehydrate the previous thread), kind (decision /
observation / constraint / open-question / principle).

Call this on session start, before the first user turn, with
session_id="last" limit=20 to pick up where the previous session ended.
  `.trim(),
  input: z
    .object({
      session_id: z.string().optional(),
      kind: z
        .enum(['decision', 'observation', 'constraint', 'open-question', 'principle'])
        .optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  output: z.object({
    waypoints: z.array(waypoint),
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
