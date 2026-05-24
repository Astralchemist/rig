import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const declaredDep = z.object({
  id: z.string(),
  name: z.string(),
  spec: z.string(),
  source: z.string(),
  manifest_path: z.string(),
  is_dev: z.boolean(),
  is_optional: z.boolean(),
  is_peer: z.boolean(),
});

export default defineToolContract({
  name: 'rig_deps',
  tier: 'light',
  summary: 'List declared dependencies from package manifests',
  description: `
List the dependencies a project declares in its package manifests (currently
package.json; more formats coming). Each entry has {name, spec, source,
manifest_path, is_dev, is_optional, is_peer}.

Use for "what does this project depend on" and "what version of X does it
declare" questions. For symbol-level lookup of how a package is imported
in code, use rig_search with the package name.
  `.trim(),
  input: z
    .object({
      manifest_path: z
        .string()
        .optional()
        .describe('Restrict to deps declared in this manifest path (relative)'),
    })
    .strict(),
  output: z.object({
    deps: z.array(declaredDep),
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
