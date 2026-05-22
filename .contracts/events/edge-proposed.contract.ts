import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'edge:proposed',
  emitted_by: ['rig_propose_edge'],
  payload: z.object({
    pending_id: z.number().int(),
    src: z.string(),
    dst: z.string(),
    kind: z.string(),
    weight: z.number(),
    provenance: z.string(),
    rationale: z.string(),
    proposed_at: z.number().int(),
  }),
  ui_effect: 'draw a dashed edge with a rationale tooltip; pulse the target',
});
