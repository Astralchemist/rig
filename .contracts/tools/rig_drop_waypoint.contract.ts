// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-summary'), content: z.string().min(1) }),
  z.object({ type: z.literal('mermaid-diagram'), content: z.string().min(1) }),
  z.object({ type: z.literal('code-snippet'), lang: z.string().min(1), content: z.string().min(1) }),
  z.object({ type: z.literal('doc-fragment'), content: z.string().min(1) }),
  z.object({ type: z.literal('image-ref'), path: z.string().min(1), alt: z.string().optional() }),
  z.object({ type: z.literal('dataset-pointer'), query: z.string().min(1) }),
]);

export default defineToolContract({
  name: 'rig_drop_waypoint',
  tier: 'write',
  summary: 'Drop a conversation waypoint at a decision point',
  description: `
Record a discrete marker the AI considers worth preserving across context
compaction or session boundaries — a decision, a constraint stated by the
user, a recurring observation, an open question, a principle, or a dead
end (an approach tried or proposed and ruled out). The
waypoint becomes a graph anchor with structured payload; predecessor ids
form a \`waypoint_succeeds\` chain; constellation refs form
\`waypoint_references\` edges to other anchors.

Use sparingly. Typical floor: at most one per ~5 turns. Drop one when a
real decision is locked, not as a running summary.

Every id in constellation_refs and predecessors must exist; otherwise the
call fails with NODE_NOT_FOUND listing the unknown ids, and nothing is
written. The rationale is stored with the waypoint; rig_waypoints and
rig_chain return it.
  `.trim(),
  input: z
    .object({
      kind: z.enum([
        'decision',
        'observation',
        'constraint',
        'open-question',
        'principle',
        'dead-end',
      ]),
      title: z.string().min(3).max(120),
      summary: z.string().min(10).max(2000),
      analogy: z.string().optional(),
      constellation_refs: z.array(z.string()).default([]),
      predecessors: z.array(z.string()).default([]),
      key_terms: z.array(z.string()).default([]),
      compactable: z.boolean().default(false),
      payloads: z.array(payload).default([]),
      rationale: z.string().min(10, 'rationale must be at least 10 characters'),
    })
    .strict(),
  output: z.object({
    id: z.string(),
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
  records_activation: false,
  provenance_required: true,
  requires_rationale: true,
  broadcasts: 'waypoint:dropped',
});
