// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_node',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Fetch anchor metadata by id',
  description: `
Return metadata for a single anchor: id, name, kind, file_path, qualified
name, signature, docstring, and neighbor counts by edge kind. Does NOT
return the source body — use rig_explore (heavy tier) for full source.

Use as a cheap inspection step after rig_search to decide whether a node
is worth pulling neighbors or callers for.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Anchor id'),
    })
    .strict(),
  output: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    file_path: z.string().optional(),
    qualified_name: z.string().optional(),
    signature: z.string().optional(),
    docstring: z.string().optional(),
    neighbor_counts: z.record(z.string(), z.number().int()),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
});
