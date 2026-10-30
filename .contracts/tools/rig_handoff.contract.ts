// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_handoff',
  tier: 'write',
  summary: 'Leave a handoff for the next session, or read it',
  description: `
Write a handoff before you stop: near a usage limit, at the end of a work
session, or when another agent will pick up the task. The next session in
this worktree and branch (another account, Claude Code, Codex, Cursor) starts
from it once, stamped with its age and commit and marked possibly stale when
the code moved. It holds what is in progress, not what was settled (use
rig_drop_waypoint for decisions): the goal, the current work, pending tasks,
the next step and the files involved. Keep it short; it is clipped to about
1,500 characters.

action "write" replaces this workstream's handoff. It is refused with
HANDOFF_LIVE while another session's handoff is unconsumed and less than two
hours old, so parallel agents don't overwrite each other; pass force: true
when replacing it is intended. action "read" returns the current handoff
without consuming it.
  `.trim(),
  input: z
    .object({
      action: z.enum(['write', 'read']).describe('write a new handoff, or read the current one'),
      current_work: z
        .string()
        .optional()
        .describe('What you were doing when you stopped (required to write)'),
      goal: z.string().optional().describe('The task as the user asked for it'),
      pending: z.array(z.string()).optional().describe('What is left, most important first'),
      next_step: z.string().optional().describe('The very next thing to do'),
      files: z.array(z.string()).optional().describe('Files involved, relative to the project'),
      force: z.boolean().optional().describe("Replace another session's live handoff"),
    })
    .strict(),
  output: z.object({
    handoff: z
      .object({
        written_at: z.number(),
        branch: z.string().nullable(),
        commit: z.string().nullable(),
        client: z.string(),
        source: z.enum(['agent', 'compact']),
        goal: z.string().optional(),
        current_work: z.string(),
        pending: z.array(z.string()),
        next_step: z.string().optional(),
        files: z.array(z.string()),
        consumed: z.boolean(),
      })
      .nullable(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'HANDOFF_LIVE', 'INVALID_ARGS'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
  provenance_required: true,
});
