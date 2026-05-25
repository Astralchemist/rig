// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'node:added',
  emitted_by: ['rig_add_node', 'rig_cluster'],
  payload: z.object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
  }),
  ui_effect: 'animate new circle into the force layout',
});
