import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const nodeRef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string().optional(),
});

export default defineToolContract({
  name: 'rig_callees',
  tier: 'light',
  summary: 'List direct callees of an anchor',
  description: `
Return the set of anchors directly called by the given function/method.
One-hop, structural edges only. Output is NodeRef[].

Use to answer "what does this depend on" or "what does this function
touch". For transitive reach use rig_impact; for general relatedness
use rig_pull.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Caller anchor id'),
    })
    .strict(),
  output: z.object({
    nodes: z.array(nodeRef),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
  },
  records_activation: true,
});
