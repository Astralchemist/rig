// SPDX-License-Identifier: Apache-2.0
// `rig consolidate [--apply]`: merge near-duplicate memories into lessons.
import { Rig } from '@rig/core';
import { consolidate } from '@rig/core/memory/consolidate.ts';

export async function runConsolidate(cwd: string): Promise<void> {
  const apply = process.argv.includes('--apply');
  const rig = await Rig.open(cwd);
  try {
    const { lessons } = consolidate(rig, { apply });
    if (!lessons.length) {
      process.stdout.write('nothing to consolidate\n');
      return;
    }
    for (const l of lessons)
      process.stdout.write(
        `${apply ? 'merged' : 'would merge'} ${l.sources.length} → "${l.title}"${l.id ? ` (${l.id})` : ''}\n`,
      );
    if (!apply)
      process.stdout.write(
        'dry run: pass --apply to write the lessons (the originals are kept, hidden)\n',
      );
  } finally {
    rig.close();
  }
}
