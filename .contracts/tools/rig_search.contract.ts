// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

const nodeRef = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string().optional(),
  score: z.number().describe('Fused relevance (reciprocal rank fusion); higher is better'),
  matched_by: z
    .array(z.enum(['name', 'alias', 'keyword', 'vector']))
    .describe('Which candidate lists found this anchor'),
});

export default defineToolContract({
  name: 'rig_search',
  tier: 'light',
  stability: 'stable',
  since: '1.0',
  summary: 'Hybrid name, keyword and semantic search over anchors',
  description: `
Find anchors by name or by a plain-language description. Takes a symbol
("AuthStore", "auth_store", "AuthStore.login", a prefix like "authStor")
or a question ("where do we refresh expired sessions?").

Fuses three candidate lists by reciprocal rank: exact name and alias
matches (always first), keyword matches (SQLite FTS5 over names,
identifier words, signatures, docstrings and doc/waypoint text, BM25
ranked; every word must match for symbol-like queries, any word for
questions) and semantic matches (cosine similarity to local embeddings).
Each hit carries score and matched_by. When the embedding model is
unavailable the vector list is left out and degraded is "keyword-only".

For "what's related to this node" use rig_pull instead — search does not
score by graph proximity.
  `.trim(),
  input: z
    .object({
      query: z.string().min(1).describe('A symbol name or a plain-language description'),
      kind: z.string().optional().describe('Filter by anchor kind (e.g. function, class)'),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  output: z.object({
    nodes: z.array(nodeRef),
    elapsed_ms: z.number(),
    degraded: z
      .literal('keyword-only')
      .optional()
      .describe('Set when semantic matching was unavailable (embedding model not loaded)'),
  }),
  errors: ['NOT_INITIALIZED', 'QUERY_INVALID'],
  permissions: {
    claude: 'auto-allow',
    cursor: 'allow',
    codex: 'auto-allow',
    opencode: 'allow',
    openrouter: 'auto-allow',
  },
  records_activation: true,
});
