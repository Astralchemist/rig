// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

export default defineAnchorContract({
  type: 'markdown-section',
  description: 'A heading inside a markdown document; nests by ATX heading level',
  extractor: 'custom',
  
  data_schema: z.object({
    heading_path: z.string(),
    file_path: z.string(),
    level: z.number().int().min(1).max(6),
    start_line: z.number().int(),
  }),
  ui: {
    icon: 'heading',
    color: 'c-amber',
    label_field: 'name',
    detail_fields: ['heading_path', 'file_path', 'level'],
  },
  allowed_edges: {
    outgoing: ['contains', 'references'],
    incoming: ['contains', 'references'],
  },
  embeddable: true,
  embedding_text: ['name', 'heading_path'],
});
