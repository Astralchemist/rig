// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'edge:accepted',
  emitted_by: ['rig_propose_edge', 'pending-edges accept REST'],
  payload: z.object({
    pending_id: z.number().int(),
    src: z.string(),
    dst: z.string(),
  }),
  ui_effect: 'dashed → solid animation',
});
