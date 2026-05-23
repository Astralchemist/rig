import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

export default defineAnchorContract({
  type: 'cluster',
  description: 'AI-curated grouping of related anchors; created by rig_cluster',
  extractor: 'manual',
  data_schema: z.object({
    members: z.array(z.string()).min(1),
    rationale: z.string().min(1),
  }),
  ui: {
    icon: 'layers',
    color: 'c-violet',
    label_field: 'name',
    detail_fields: ['rationale', 'members'],
  },
  allowed_edges: {
    outgoing: ['contains'],
    incoming: ['references'],
  },
  embeddable: true,
  embedding_text: ['name', 'rationale'],
});
