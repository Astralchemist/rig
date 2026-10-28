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
Build a context bundle for a task: runs the same hybrid search as
rig_search on the task text — exact names and aliases first, then
keyword (FTS5, BM25) and semantic (local embeddings) matches fused by
reciprocal rank — over anchors that have source in a file, and returns
the top max_nodes in that order with their source bodies, formatted for
direct LLM consumption (markdown by default; JSON available). A
plain-language task ("fix the login bug") finds anchors as well as a
symbol name does. degraded is "keyword-only" when the embedding model
was unavailable. It does not rank by magnetic pull: call rig_pull on a
hit for the anchors related to it.

Heavy tier — the bundle carries full source bodies, so it costs far more
context than the light tools. Use rig_explore for raw exploration; use
rig_context when you want a single ready-to-prompt block.

The response is capped at about 60,000 characters. Sources cut to fit
end with a "… [truncated: N of M lines shown]" line and truncated is
true; lower max_nodes or narrow the task to get whole bodies.
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
    truncated: z.boolean().describe('True when a source was cut to fit the response cap'),
    degraded: z
      .literal('keyword-only')
      .optional()
      .describe('Set when semantic matching was unavailable (embedding model not loaded)'),
  }),
  // MAIN_SESSION_FORBIDDEN is no longer raised: MCP can't tell a main session
  // from a sub-agent, so the gate is gone. Removing an error code from a stable
  // tool is a breaking change, so it stays declared until a major manifest bump.
  errors: ['NOT_INITIALIZED', 'MAIN_SESSION_FORBIDDEN'],
  permissions: {
    claude: 'ask',
    cursor: 'ask',
    codex: 'ask',
    opencode: 'ask',
    openrouter: 'ask',
  },
  records_activation: true,
});
