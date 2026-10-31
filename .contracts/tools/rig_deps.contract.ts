// SPDX-License-Identifier: Apache-2.0
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
  resolved_version: z.string().nullable(),
  purl: z.string().nullable(),
  used_by: z.number(),
});

export default defineToolContract({
  name: 'rig_deps',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'List declared dependencies from package manifests',
  description: `
List the dependencies a project declares in its package manifests
(package.json, requirements.txt, pyproject.toml). Each entry has {name, spec,
source, manifest_path, is_dev, is_optional, is_peer, resolved_version, purl,
used_by}: purl is the package URL (pkg:npm/..., pkg:pypi/...), versioned when
a lockfile or exact pin gives one version; used_by counts the files and
symbols whose imports resolve to it (imports_package edges).

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
