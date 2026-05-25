// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

export default defineAnchorContract({
  type: 'declared-dependency',
  description:
    'A dependency declared in a package-manifest file (package.json, requirements.txt, pyproject.toml, etc.). Carries its version spec + dev/runtime classification on the node.',
  extractor: 'custom',
  data_schema: z.object({
    name: z.string(),
    spec: z.string().describe('Version spec as authored (e.g. "^2.1.0", "~=1.4", "*")'),
    source: z
      .enum(['npm', 'pypi', 'crates.io', 'go-modules', 'unknown'])
      .default('unknown'),
    manifest_path: z.string(),
    is_dev: z.boolean().default(false),
    is_optional: z.boolean().default(false),
    is_peer: z.boolean().default(false),
  }),
  ui: {
    icon: 'package',
    color: 'c-violet',
    label_field: 'name',
    detail_fields: ['spec', 'manifest_path', 'source'],
  },
  allowed_edges: {
    outgoing: ['resolves_to'],
    incoming: ['manifest_declares', 'imports_package'],
  },
  embeddable: false,
  embedding_text: [],
});
