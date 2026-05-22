import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const eventRow = z.object({
  id: z.number().int(),
  ts: z.number().int(),
  session_id: z.string(),
  kind: z.string(),
  payload: z.unknown(),
  actor: z.string(),
});

export default defineToolContract({
  name: 'rig_subscribe',
  tier: 'live',
  summary: 'Pull mutation events since a cursor',
  description: `
Long-poll endpoint for following the user's UI activity from an agent
session. Pass the last next_cursor value you saw; receive every
mutation_log row since then (selections, edges proposed/accepted/
rejected, nodes added). Polling every 2s is a good default.

Use this to inject "user is now looking at <anchor>" context into your
next agent turn without the user typing.
  `.trim(),
  input: z
    .object({
      since_ts: z.number().int().default(0),
      session_id: z.string().optional(),
    })
    .strict(),
  output: z.object({
    events: z.array(eventRow),
    next_cursor: z.number().int(),
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
  subscription_kind: 'mutation_log',
});
