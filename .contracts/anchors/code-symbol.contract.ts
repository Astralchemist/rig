// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

export default defineAnchorContract({
  type: 'code-symbol',
  description: 'A function, class, method, or other code-level identifier',
  extractor: 'tree-sitter',
  data_schema: z.object({
    qualified_name: z.string(),
    file_path: z.string(),
    start_line: z.number().int(),
    end_line: z.number().int(),
    signature: z.string().optional(),
    docstring: z.string().optional(),
    is_exported: z.boolean().default(false),
  }),
  ui: {
    icon: 'function',
    color: 'c-teal',
    label_field: 'name',
    detail_fields: ['qualified_name', 'file_path', 'signature'],
  },
  allowed_edges: {
    outgoing: ['calls', 'imports', 'extends', 'implements', 'contains', 'references'],
    incoming: ['calls', 'extends', 'implements', 'contains', 'references'],
  },
  embeddable: true,
  embedding_text: ['name', 'qualified_name', 'docstring', 'signature'],
});
