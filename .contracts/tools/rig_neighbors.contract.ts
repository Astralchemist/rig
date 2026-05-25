import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const edgeRef = z.object({
  src: z.string(),
  dst: z.string(),
  kind: z.string(),
  weight: z.number().optional(),
  table: z.enum(['structural', 'semantic']),
});

export default defineToolContract({
  name: 'rig_neighbors',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'List edges touching a node',
  description: `
Return edges incident to the given anchor in both directions, from both
the structural and semantic edge tables. Output is a flat EdgeRef list
with {src, dst, kind, weight?, table}.

Use when you want the raw graph view ("what does this connect to") rather
than a ranked similarity view. For "what's most related" use rig_pull —
it scores by structural distance + semantic similarity + recency.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Anchor id'),
      kind: z.string().optional().describe('Filter edges by kind (e.g. calls, imports)'),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  output: z.object({
    edges: z.array(edgeRef),
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
