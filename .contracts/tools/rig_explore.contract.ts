// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const related = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
});

const anchor = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  source: z.string(),
  related: z.array(related),
});

export default defineToolContract({
  name: 'rig_explore',
  tier: 'heavy',
  stability: 'stable',
  since: '1.0',
  summary: 'Full neighborhoods + source for a question',
  description: `
Search the index for a question and return the top-K anchors with their
source bodies and one-hop related anchors. Returns full file slices, so
this is token-heavy.

NEVER call this in the main agent session — spawn a sub-agent. The
two-tier gate is enforced by the dispatcher (MAIN_SESSION_FORBIDDEN).
For lightweight metadata-only navigation use rig_pull or rig_neighbors.
  `.trim(),
  input: z
    .object({
      question: z.string().min(1).describe('Free-text question or topic'),
      max_anchors: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  output: z.object({
    anchors: z.array(anchor),
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
