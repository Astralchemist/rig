import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const nodeRef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string().optional(),
});

export default defineToolContract({
  name: 'rig_search',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'FTS5 search over anchor names',
  description: `
Find anchors by name or qualified name via SQLite FTS5. Returns
{id, name, kind, file_path?} matches ranked by FTS relevance.

Use this for "where is X defined" or "find a symbol named Y" questions.
For "what's related to this node" use rig_pull instead — search does not
score by graph proximity or semantic similarity.
  `.trim(),
  input: z
    .object({
      query: z.string().min(1).describe('FTS5 query string'),
      kind: z.string().optional().describe('Filter by anchor kind (e.g. function, class)'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({
    nodes: z.array(nodeRef),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'QUERY_INVALID'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
