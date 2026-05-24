import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const conflictEntry = z.object({
  name: z.string(),
  source: z.string(),
  manifests: z.array(
    z.object({
      manifest_path: z.string(),
      spec: z.string(),
      is_dev: z.boolean(),
    }),
  ),
});

export default defineToolContract({
  name: 'rig_dep_conflicts',
  tier: 'light',
  summary: 'Packages declared with different versions across manifests',
  description: `
Return every dependency name (scoped per ecosystem source) that appears in
two or more manifests with different version specs. Same-name-different-source
(e.g. an npm package and a PyPI package that happen to share a name) is not a
conflict — only intra-ecosystem disagreement is flagged.

Use to spot drift before it bites: pandas at 2.1.4 in requirements.txt and
2.2.0 in pyproject.toml is the classic case.
  `.trim(),
  input: z.object({}).strict(),
  output: z.object({
    conflicts: z.array(conflictEntry),
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
