import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const fileInfo = z.object({
  path: z.string(),
  language: z.string().optional(),
  node_count: z.number().int(),
  last_indexed_ts: z.number().int().optional(),
});

export default defineToolContract({
  name: 'rig_files',
  tier: 'light',
  summary: 'List indexed files',
  description: `
List files known to the rig index, optionally filtered by a substring of
the file path. Each entry has {path, language?, node_count,
last_indexed_ts?}.

Use for "what does rig know about" sanity checks and to discover entry
points before searching. For symbol lookup inside a file use rig_search
with a kind filter.
  `.trim(),
  input: z
    .object({
      filter: z.string().optional().describe('Substring filter on file path'),
    })
    .strict(),
  output: z.object({
    files: z.array(fileInfo),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
  },
  records_activation: false,
});
