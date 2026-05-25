// SPDX-License-Identifier: Apache-2.0
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { allTargetNames, getTarget } from './install/loader.ts';
import { installTarget, type InstallOptions } from './install/runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(findAssetRoot(HERE), 'generated/installer');

const flag = (name: string): boolean => process.argv.includes(name);
const optionValue = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
};

export async function runInstall(cwd: string): Promise<void> {
  const targetArg =
    process.argv.slice(3).find((a) => !a.startsWith('--')) ?? 'claude';
  const contract = getTarget(targetArg);
  if (!contract) {
    process.stderr.write(
      `rig: unknown target '${targetArg}'. Known: ${allTargetNames().join(', ')}\n`,
    );
    process.exit(2);
  }

  const opts: InstallOptions = {
    rigBin: optionValue('--bin') ?? 'rig',
    cursorPath: cwd,
    generatedDir: GENERATED_DIR,
    dryRun: flag('--dry-run'),
  };

  const label = opts.dryRun ? '(dry run)' : '';
  process.stdout.write(`rig install ${targetArg} ${label}\n`);
  const result = await installTarget(contract, opts);
  process.stdout.write(`  detected: ${result.detected}\n`);
  for (const a of result.applied) {
    const mark = a.status === 'wrote' ? '✓' : a.status === 'dry-run' ? '~' : '·';
    process.stdout.write(
      `  ${mark} ${a.status.padEnd(22)} ${a.mode.padEnd(15)} ${a.path}\n`,
    );
    if (a.reason) process.stdout.write(`      ${a.reason}\n`);
  }
}
