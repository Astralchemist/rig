// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { scopeLabel } from './install-cmd.ts';
import { parseArgs } from './install/args.ts';
import { allTargetNames, getTarget } from './install/loader.ts';
import { displayPath, type Scope } from './install/paths.ts';
import { hasScope } from './install/runner.ts';
import { uninstallTarget, type RemoveResult } from './install/uninstall.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(findAssetRoot(HERE), 'generated/installer');

const other = (s: Scope): Scope => (s === 'project' ? 'global' : 'project');

const label = (r: RemoveResult, dryRun: boolean): string => {
  if (!dryRun || (r.status !== 'removed' && r.status !== 'deleted')) return r.status;
  return r.status === 'removed' ? 'would remove' : 'would delete';
};

// `rig uninstall <target…> | --all  [--global] [--dry-run]`
// Removes exactly what `rig install` added — the rig server entry, rig's own
// permission entries, rig's instructions section — from this project, or with
// --global from the user-level config, and prints every change.
export async function runUninstall(cwd: string): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const all = args.flags.has('--all');
  if (!all && !args.positionals.length) {
    process.stderr.write(
      'usage: rig uninstall <target…> | --all  [--global] [--dry-run]\n' +
        `       targets: ${allTargetNames().join(', ')}\n`,
    );
    process.exit(2);
  }
  for (const name of args.positionals) {
    if (!getTarget(name)) {
      process.stderr.write(
        `rig: unknown target '${name}'. Known: ${allTargetNames().join(', ')}\n`,
      );
      process.exit(2);
    }
  }

  const names = all ? allTargetNames() : args.positionals;
  const projectRoot = resolve(cwd);
  const home = homedir();
  const requested: Scope = args.flags.has('--global') ? 'global' : 'project';
  const dryRun = args.flags.has('--dry-run');

  for (const name of names) {
    const contract = getTarget(name)!;
    let scope = requested;
    if (!hasScope(contract, requested)) {
      if (all) {
        // --all stays in the scope asked for; name the target to cross over.
        process.stdout.write(
          `· ${contract.display_name}: no ${requested === 'project' ? 'project' : 'user'}-level files — ` +
            `\`rig uninstall ${name}${requested === 'project' ? ' --global' : ''}\` removes it\n`,
        );
        continue;
      }
      scope = other(requested);
    }
    if (scope === 'project' && projectRoot === resolve(home)) {
      process.stderr.write(
        `rig: ${projectRoot} is your home directory — its project files are your user config.\n` +
          `     Run \`rig uninstall ${name}\` inside a project, or pass --global.\n`,
      );
      process.exit(2);
    }

    process.stdout.write(
      `rig uninstall ${name} (${scopeLabel(scope, projectRoot)})${dryRun ? ' (dry run — nothing changed)' : ''}\n`,
    );
    if (scope !== requested) {
      process.stdout.write(
        `  ${contract.display_name} has no ${requested === 'project' ? 'project' : 'user'}-level files — ` +
          `removing its ${scope === 'global' ? 'user-level' : 'project'} ones instead.\n`,
      );
    }
    const result = await uninstallTarget(contract, {
      rigBin: 'rig',
      generatedDir: GENERATED_DIR,
      projectRoot,
      home,
      scope,
      dryRun,
    });
    for (const r of result.removed) {
      const changed = r.status === 'removed' || r.status === 'deleted';
      const mark = changed ? (dryRun ? '~' : '✓') : '·';
      process.stdout.write(
        `  ${mark} ${label(r, dryRun).padEnd(12)} ${r.role.padEnd(12)} ${displayPath(r.path, projectRoot, home)} — ${r.detail}\n`,
      );
    }
  }
}
