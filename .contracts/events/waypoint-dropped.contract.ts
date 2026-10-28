// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'waypoint:dropped',
  emitted_by: ['rig_drop_waypoint'],
  payload: z.object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    session_id: z.string(),
    constellation_refs: z.array(z.string()),
    predecessors: z.array(z.string()),
  }),
  ui_effect: 'drop a waypoint marker linked to the anchors it references',
});
