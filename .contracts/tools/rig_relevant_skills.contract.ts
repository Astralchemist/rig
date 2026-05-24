import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const skill = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string(),
  summary: z.string().nullable(),
  description: z.string(),
});

export default defineToolContract({
  name: 'rig_relevant_skills',
  tier: 'light',
  summary: 'Top-k AI tools most relevant to a query',
  description: `
Rank the agent's own MCP tools (seeded as 'skill' anchors at startup) by
relevance to a free-text intent. Useful when the agent itself wants to
discover which of its tools to call — "I need to validate this externally"
ranks browser/web tools high; "what is connected to X" ranks
rig_pull/rig_neighbors high.

Same retrieval substrate as rig_search; this just narrows to skill anchors
and returns the tier+description so the agent has enough to pick.
  `.trim(),
  input: z
    .object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  output: z.object({
    skills: z.array(skill),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
