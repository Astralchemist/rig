// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const aliasRef = z.object({
  alias: z.string(),
  provenance: z.string(),
  rationale: z.string().nullable(),
  created_at: z.number().int(),
});

export default defineToolContract({
  name: 'rig_aliases',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'List the aliases registered for an anchor',
  description: `
Return every alias name pointing at a given canonical anchor. Aliases are
alternate names (e.g. \`pd\` for \`pandas\`, \`useState\` for \`React.useState\`)
that resolve to the same node via FTS5 search. Each carries the actor that
registered it.
  `.trim(),
  input: z
    .object({
      id: z.string(),
    })
    .strict(),
  output: z.object({
    aliases: z.array(aliasRef),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: false,
});
