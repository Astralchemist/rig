import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const payload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-summary'), content: z.string() }),
  z.object({ type: z.literal('mermaid-diagram'), content: z.string() }),
  z.object({ type: z.literal('code-snippet'), lang: z.string(), content: z.string() }),
  z.object({ type: z.literal('doc-fragment'), content: z.string() }),
  z.object({ type: z.literal('image-ref'), path: z.string(), alt: z.string().optional() }),
  z.object({ type: z.literal('dataset-pointer'), query: z.string() }),
]);

const waypoint = z.object({
  id: z.string(),
  ts: z.number().int(),
  session_id: z.string(),
  kind: z.enum(['decision', 'observation', 'constraint', 'open-question', 'principle']),
  title: z.string(),
  summary: z.string(),
  analogy: z.string().nullable(),
  constellation_refs: z.array(z.string()),
  predecessors: z.array(z.string()),
  key_terms: z.array(z.string()),
  compactable: z.boolean(),
  payloads: z.array(payload),
});

export default defineToolContract({
  name: 'rig_chain',
  tier: 'light',
  summary: 'Walk the predecessor chain of a waypoint',
  description: `
Starting at a given waypoint, walk the waypoint_succeeds edges backward
through history up to maxDepth hops. Returns the seed at index 0 followed
by its predecessors in order. Use to reconstruct the reasoning thread
that led to a decision.
  `.trim(),
  input: z
    .object({
      id: z.string().describe('Waypoint id to start the chain at'),
      max_depth: z.number().int().min(1).max(50).default(10),
    })
    .strict(),
  output: z.object({
    chain: z.array(waypoint),
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
