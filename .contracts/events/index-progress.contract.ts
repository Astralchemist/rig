// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineEventContract } from '@rig/contracts';

// Emitted while `rig start` indexes a project, so the map can animate the
// codebase assembling itself in real time. One event per progress tick, plus
// a final tick with phase='done' carrying the totals. The db:changed file
// watcher already nudges a graph re-pull; this adds the phase + counts the UI
// needs for a progress affordance.
export default defineEventContract({
  name: 'index:progress',
  emitted_by: ['rig index', 'rig start'],
  payload: z.object({
    phase: z.string(), // extract | resolve | embed | tests-edges | hubness | communities | done
    current: z.number().optional(),
    total: z.number().optional(),
    detail: z.string().optional(),
    done: z.boolean().optional(),
    // present only on the final phase='done' tick:
    nodes: z.number().optional(),
    edges: z.number().optional(),
    files: z.number().optional(),
  }),
  ui_effect: 'show indexing progress; on done, settle the constellation',
});
