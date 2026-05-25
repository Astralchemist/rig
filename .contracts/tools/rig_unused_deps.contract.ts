// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const unused = z.object({
  id: z.string(),
  name: z.string(),
  spec: z.string(),
  source: z.string(),
  manifest_path: z.string(),
  is_dev: z.boolean(),
});

export default defineToolContract({
  name: 'rig_unused_deps',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Declared dependencies with no matching imports in source',
  description: `
Heuristic: a declared dependency is flagged when its package name never
appears as the target of a bare-specifier import anywhere in the indexed
source. Handles scoped packages (\`@types/node\`) and subpath imports
(\`lodash/get\` counts as a use of \`lodash\`).

Possible false positives: JSX runtimes, bundler-only deps, runtime configs.
Treat the result as "likely removable, verify before deleting", not as an
authoritative dead-code report.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    unused: z.array(unused),
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
