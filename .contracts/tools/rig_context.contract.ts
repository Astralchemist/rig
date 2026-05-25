// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_context',
  tier: 'heavy',
  stability: 'stable',
  since: '1.0',
  summary: 'Build a context bundle for a task',
  description: `
Build a context bundle of the top-K anchors most relevant to a task,
formatted for direct LLM consumption (markdown by default; JSON
available). Uses search + magnetic-pull ranking.

Heavy tier — must be invoked from a sub-agent, not the main session.
Use rig_explore for raw exploration; use rig_context when you want a
single ready-to-prompt block.
  `.trim(),
  input: z
    .object({
      task: z.string().min(1).describe('What the agent is trying to do'),
      max_nodes: z.number().int().min(1).max(50).default(10),
      format: z.enum(['markdown', 'json']).default('markdown'),
    })
    .strict(),
  output: z.object({
    context: z.string(),
    anchor_count: z.number().int(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'MAIN_SESSION_FORBIDDEN'],
  permissions: {
    claude: 'ask',
    cursor: 'ask',
    codex: 'ask',
    opencode: 'ask',
    openrouter: 'ask',
  },
  records_activation: true,
  main_session_forbidden: true,
});
