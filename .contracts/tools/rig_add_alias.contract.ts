// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_add_alias',
  tier: 'write',
  summary: 'Register an alias that resolves to a canonical anchor',
  description: `
Add an alternate name for an anchor so searches for the alias return the
canonical node. Use for AI-discovered or user-asserted alternate names
(e.g. \`pd\` → \`pandas\`, \`useState\` → \`React.useState\`).

The alias is registered with the caller's provenance. Re-adding the same
(node, alias) pair is a no-op; the second call returns added=false.
  `.trim(),
  input: z
    .object({
      id: z.string(),
      alias: z.string().min(1).max(120),
      rationale: z.string().min(10, 'rationale must be at least 10 characters'),
    })
    .strict(),
  output: z.object({
    added: z.boolean(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND', 'PROVENANCE_REQUIRED', 'RATIONALE_REQUIRED'],
  permissions: {
    claude: 'ask',
    cursor: 'ask',
    codex: 'ask',
    opencode: 'ask',
    openrouter: 'ask',
  },
  records_activation: false,
  provenance_required: true,
  requires_rationale: true,
  broadcasts: 'alias:added',
});
