// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { defineToolContract } from '@rig/contracts';

// Budget bounds mirror MIN_/MAX_OVERVIEW_BUDGET in packages/core/src/orientation.ts.
export default defineToolContract({
  name: 'rig_overview',
  tier: 'light',
  stability: 'experimental',
  summary: 'Compact map of the repository; call first',
  description: `
Start here. Returns a compact markdown map of the repository, about 2,000
tokens by default: project basics (languages, packages, key dependencies),
entry points (manifest exports, bin and index files mapped to source),
module layout with one-line purposes, the most-referenced files and
exported symbols with signatures and file:line, request/handler surfaces
(string-literal unions and enums, handler directories and the functions
that dispatch to them, HTTP verb exports), where tests live and what they
import, and recent decision waypoints. Every line names real paths.

Call it once at the start of a session, before searching, and answer
simple "where is / which file / what version" questions from it directly.
Built from the index alone (no model) and refreshed by \`rig index\`,
\`rig sync\` and the file watcher; generated_at says when. budget is in
tokens (default 2000); a larger budget shows more of every section. The
same map is the MCP resource rig://overview.
  `.trim(),
  input: z
    .object({
      budget: z
        .number()
        .int()
        .min(200)
        .max(20000)
        .optional()
        .describe('Token budget for the map (default 2000)'),
    })
    .strict(),
  output: z.object({
    map: z.string(),
    generated_at: z.number().int(),
    nodes: z.number().int(),
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
