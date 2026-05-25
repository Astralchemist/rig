// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'node:promoted',
  emitted_by: ['rig_promote'],
  payload: z.object({
    id: z.string(),
    hubness: z.number(),
  }),
  ui_effect: 'pulse the promoted node; increase its radius to hub size',
});
