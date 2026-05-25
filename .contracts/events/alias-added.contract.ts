// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'alias:added',
  emitted_by: ['rig_add_alias'],
  payload: z.object({
    node_id: z.string(),
    alias: z.string(),
  }),
  ui_effect: 'flash an alias chip on the canonical node',
});
