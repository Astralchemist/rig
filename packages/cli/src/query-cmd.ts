// SPDX-License-Identifier: Apache-2.0
import { Rig } from '@rig/core';

const flag = (name: string): boolean => process.argv.includes(name);
const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

export async function runQuery(cwd: string): Promise<void> {
  const args = process.argv.slice(3);
  const query = args.find((a) => !a.startsWith('--'));
  if (!query) {
    process.stderr.write(`usage: rig query <search> [--kind <kind>] [--limit <n>] [--json]\n`);
    process.exit(2);
  }
  const limitStr = optionValue('--limit');
  const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;

  const rig = await Rig.open(cwd);
  try {
    const hits = rig.searchNodes(query, {
      ...(optionValue('--kind') !== undefined ? { kind: optionValue('--kind')! } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (flag('--json')) {
      process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
    } else {
      for (const n of hits) {
        const fp = typeof n.data.filePath === 'string' ? n.data.filePath : '';
        process.stdout.write(`${n.type.padEnd(10)} ${n.name.padEnd(30)} ${fp}\n`);
      }
      process.stderr.write(`${hits.length} result(s)\n`);
    }
  } finally {
    rig.close();
  }
}
