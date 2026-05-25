// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'edge:rejected',
  emitted_by: ['pending-edges reject REST'],
  payload: z.object({
    pending_id: z.number().int(),
  }),
  ui_effect: 'dashed edge fades out',
});
