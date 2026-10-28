// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_context.contract.ts';
import { queryHash, type ToolContext } from '../dispatch.ts';
import { fitSources } from './_budget.ts';
import { readSnippet, viewOf, type NodeView } from './_snippet.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

interface Block extends NodeView {
  source: string;
}

const toMarkdown = (blocks: readonly Block[]): string =>
  blocks
    .map((b) =>
      [
        `## ${b.name} _(${b.kind})_`,
        `\`${b.file_path}:${b.start_line}-${b.end_line}\``,
        '',
        '```',
        b.source,
        '```',
        '',
      ].join('\n'),
    )
    .join('\n');

export async function run(args: Args, ctx: ToolContext): Promise<Result> {
  const start = Date.now();
  const hits = ctx.rig.searchNodes(args.task, { limit: args.max_nodes });
  ctx.recordActivation(
    hits.map((n) => n.id),
    { queryHash: queryHash(args.task) },
  );
  const blocks: Block[] = await Promise.all(
    hits.map(async (n) => {
      const v = viewOf(n);
      return { ...v, source: await readSnippet(ctx.rig.projectRoot, v) };
    }),
  );
  const format = (bs: readonly Block[]): string =>
    args.format === 'json' ? JSON.stringify(bs, null, 2) : toMarkdown(bs);
  // Trim source bodies (never whole anchors) so the response stays under the
  // client's tool-response cap.
  const { items, truncated } = fitSources(blocks, (bs) =>
    JSON.stringify({ context: format(bs), anchor_count: bs.length, elapsed_ms: 0, truncated: true }),
  );
  return {
    context: format(items),
    anchor_count: items.length,
    elapsed_ms: Date.now() - start,
    truncated,
  };
}
