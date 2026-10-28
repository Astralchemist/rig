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
source bodies and one-hop related anchors. Anchors come from the same
hybrid search as rig_search (exact names, keywords and semantic
similarity), limited to anchors with source in a file, so a
plain-language question works; degraded is "keyword-only" when the
embedding model was unavailable. Returns full file slices, so
this is token-heavy: navigate with the light tools first and call this
once you know which code you need. For lightweight metadata-only
navigation use rig_pull or rig_neighbors.

The response is capped at about 60,000 characters. Sources cut to fit
end with a "… [truncated: N of M lines shown]" line and truncated is
true; lower max_anchors or narrow the question to get whole bodies.
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
