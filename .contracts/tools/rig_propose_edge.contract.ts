import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

export default defineToolContract({
  name: 'rig_propose_edge',
  tier: 'write',
  summary: 'Propose a semantic edge between two anchors',
  description: `
Write a pending semantic edge that the user must accept before it becomes
canonical. Rationale is shown in the accept popover and stored in the
mutation_log forever.

Prefer rig_propose_edge to creating edges directly — the user accepts
the connection before it solidifies.
  `.trim(),
  input: z
    .object({
      src: z.string(),
      dst: z.string(),
      kind: z.string().default('related'),
      weight: z.number().min(0).max(1).default(0.5),
      rationale: z.string().min(10, 'rationale must be at least 10 characters'),
      // E1 — URLs the agent visited / cited while validating this proposal.
      // Surfaced in the accept popover so the human reviewer sees the evidence.
      source_urls: z.array(z.string().url()).max(10).default([]),
    })
    .strict(),
  output: z.object({
    pending_id: z.number().int(),
    elapsed_ms: z.number(),
  }),
  errors: ['NOT_INITIALIZED', 'NODE_NOT_FOUND', 'PROVENANCE_REQUIRED', 'RATIONALE_REQUIRED'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
  provenance_required: true,
  requires_rationale: true,
  broadcasts: 'edge:proposed',
});
