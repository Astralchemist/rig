// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import contract from '../../../../.contracts/tools/rig_context.contract.ts';
import type { ToolContext } from '../dispatch.ts';
import { readSnippet, viewOf, type NodeView } from './_snippet.ts';

type Args = z.infer<typeof contract.input>;
type Result = z.infer<typeof contract.output>;

interface Block extends NodeView {
  source: string;
}

const toMarkdown = (blocks: Block[]): string =>
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
  const blocks: Block[] = await Promise.all(
    hits.map(async (n) => {
      const v = viewOf(n);
      return { ...v, source: await readSnippet(ctx.rig.projectRoot, v) };
    }),
  );
  const context = args.format === 'json' ? JSON.stringify(blocks, null, 2) : toMarkdown(blocks);
  return { context, anchor_count: blocks.length, elapsed_ms: Date.now() - start };
}
