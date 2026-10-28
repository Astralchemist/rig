// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

export default defineEventContract({
  name: 'node:annotated',
  emitted_by: ['rig_annotate'],
  payload: z.object({
    node_id: z.string(),
    annotation_id: z.number().int(),
    note: z.string(),
  }),
  ui_effect: 'flash a note badge on the annotated node',
});
