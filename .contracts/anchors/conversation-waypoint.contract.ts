import { z } from 'zod';
import { defineAnchorContract } from '@rig/contracts';

// B1 — a structured marker the AI drops at decision points in a conversation.
// Survives context-window compaction because the agent is instructed to
// preserve the JSON payload verbatim while everything else can be summarized.
export default defineAnchorContract({
  type: 'conversation-waypoint',
  description:
    'A discrete decision/observation/constraint/open-question/principle marker dropped by the AI during a session. Carries an analogy + summary + refs into the graph so future sessions can rehydrate the reasoning thread.',
  extractor: 'manual',
  data_schema: z.object({
    session_id: z.string(),
    type: z.enum(['decision', 'observation', 'constraint', 'open-question', 'principle']),
    title: z.string(),
    analogy: z.string().optional(),
    summary: z.string(),
    constellation_refs: z.array(z.string()).default([]),
    predecessors: z.array(z.string()).default([]),
    key_terms: z.array(z.string()).default([]),
    compactable: z.boolean().default(false),
    // B2 — multi-modal payloads. Each payload is a self-contained chunk the
    // agent can re-render later (a diagram, a snippet, a doc fragment). Heavy
    // binary payloads (images, large datasets) ride out-of-band via paths;
    // text-shaped payloads live inline.
    payloads: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text-summary'), content: z.string() }),
          z.object({ type: z.literal('mermaid-diagram'), content: z.string() }),
          z.object({ type: z.literal('code-snippet'), lang: z.string(), content: z.string() }),
          z.object({ type: z.literal('doc-fragment'), content: z.string() }),
          z.object({ type: z.literal('image-ref'), path: z.string(), alt: z.string().optional() }),
          z.object({ type: z.literal('dataset-pointer'), query: z.string() }),
        ]),
      )
      .default([]),
  }),
  ui: {
    icon: 'flag',
    color: 'c-cyan',
    label_field: 'title',
    detail_fields: ['type', 'summary', 'analogy', 'key_terms'],
  },
  allowed_edges: {
    outgoing: ['waypoint_succeeds', 'waypoint_references'],
    incoming: ['waypoint_succeeds'],
  },
  embeddable: true,
  embedding_text: ['title', 'summary', 'analogy', 'key_terms'],
});
