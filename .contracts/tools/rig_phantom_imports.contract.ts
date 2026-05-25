// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const phantom = z.object({
  target_name: z.string(),
  occurrences: z.number().int(),
  sample_file: z.string(),
  sample_line: z.number().int(),
});

export default defineToolContract({
  name: 'rig_phantom_imports',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Bare imports with no matching declared dependency',
  description: `
Mirror of rig_unused_deps: returns import sites whose target package name
has no matching declared dependency in any manifest. Common causes are a
missing entry in package.json / requirements.txt, a typo, or reliance on a
transitive dep that should be declared directly.

Subpath imports normalize to the parent package (\`lodash/get\` → \`lodash\`);
relative + absolute paths are not counted as phantoms.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    phantoms: z.array(phantom),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
