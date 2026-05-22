import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'selection:changed',
  emitted_by: ['web UI'],
  payload: z.object({
    node_id: z.string().nullable(),
  }),
  ui_effect: 'synchronise selection across other open tabs',
});
