// SPDX-License-Identifier: Apache-2.0
// `rig blueprint`: the project drawn like a house plan (backlog E4).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Rig } from '@rig/core';
import { blueprintToMermaid, buildBlueprint, type BlueprintLevel } from '@rig/core/blueprint.ts';

const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

export async function runBlueprint(cwd: string): Promise<void> {
  const level = (optionValue('--level') ?? 'floor') as BlueprintLevel;
  const format = optionValue('--format') ?? 'mermaid';
  if (!['site', 'floor'].includes(level) || !['mermaid', 'json'].includes(format)) {
    process.stderr.write(
      'usage: rig blueprint [--level site|floor] [--format mermaid|json] [--out <file>]\n',
    );
    process.exit(2);
  }
  let commit: string | null = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    commit = null;
  }
  const rig = await Rig.open(cwd);
  try {
    const b = buildBlueprint(rig.database.adapter, rig.projectRoot, { level, commit });
    const text = format === 'json' ? JSON.stringify(b, null, 2) : blueprintToMermaid(b);
    const out = optionValue('--out');
    if (out) {
      writeFileSync(resolve(cwd, out), text + '\n');
      process.stderr.write(`wrote ${out} (${b.boxes.length} boxes, ${b.edges.length} edges)\n`);
    } else process.stdout.write(text + '\n');
  } finally {
    rig.close();
  }
}
