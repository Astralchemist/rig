import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

// C4 — the AI's own toolset, surfaced as graph anchors. Once skills are nodes
// they're searchable / pull-rankable the same way knowledge is: rig_pull on a
// task anchor can return relevant SKILLS alongside relevant code.
export default defineAnchorContract({
  type: 'skill',
  description:
    'An AI-callable tool exposed by the MCP server (e.g. rig_pull, rig_search). Seeded from the tools-manifest at session startup.',
  extractor: 'manual',
  data_schema: z.object({
    tier: z.enum(['light', 'heavy', 'write', 'live']),
    summary: z.string().optional(),
    description: z.string(),
    records_activation: z.boolean().default(false),
  }),
  ui: {
    icon: 'wrench',
    color: 'c-fuchsia',
    label_field: 'name',
    detail_fields: ['tier', 'summary'],
  },
  allowed_edges: {
    outgoing: ['references'],
    incoming: ['references', 'invoked_in_session'],
  },
  embeddable: true,
  embedding_text: ['name', 'description', 'summary'],
});
