import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'focus:requested',
  emitted_by: ['rig_focus'],
  payload: z.object({
    node_ids: z.array(z.string()),
  }),
  ui_effect: 'camera pan + zoom to fit the listed nodes',
});
