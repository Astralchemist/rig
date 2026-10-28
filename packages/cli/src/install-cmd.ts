// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAssetRoot } from '@rig/core/asset-root.ts';
import { parseArgs } from './install/args.ts';
import { allTargetNames, getTarget } from './install/loader.ts';
import { displayPath, type Scope } from './install/paths.ts';
import { hasScope, installTarget, type InstallOptions } from './install/runner.ts';
import { wiredLocations } from './install/uninstall.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(findAssetRoot(HERE), 'generated/installer');

const other = (s: Scope): Scope => (s === 'project' ? 'global' : 'project');

// Where a scope writes, for the header line.
export const scopeLabel = (scope: Scope, projectRoot: string): string =>
  scope === 'project' ? `project: ${projectRoot}` : 'global: ~';

// `rig install [target…] [--global] [--dry-run] [--bin <path>]`
// Project scope (the default) writes into the current directory; --global
// writes the user-level config every project shares. A target with no files
// for the requested scope falls back to the other one, and says so.
export async function runInstall(cwd: string): Promise<void> {
  const args = parseArgs(process.argv.slice(3), ['--bin']);
  const names = args.positionals.length ? args.positionals : ['claude'];
  for (const name of names) {
    if (!getTarget(name)) {
      process.stderr.write(
        `rig: unknown target '${name}'. Known: ${allTargetNames().join(', ')}\n`,
      );
      process.exit(2);
    }
  }

  const projectRoot = resolve(cwd);
  const home = homedir();
  const requested: Scope = args.flags.has('--global') ? 'global' : 'project';
  const dryRun = args.flags.has('--dry-run');

  for (const name of names) {
    const contract = getTarget(name)!;
    const scope = hasScope(contract, requested) ? requested : other(requested);
    if (scope === 'project' && projectRoot === resolve(home)) {
      process.stderr.write(
        `rig: ${projectRoot} is your home directory — project files here would land in your user config.\n` +
          `     Run \`rig install ${name}\` inside a project, or pass --global.\n`,
      );
      process.exit(2);
    }

    const opts: InstallOptions = {
      rigBin: args.values.get('--bin') ?? 'rig',
      generatedDir: GENERATED_DIR,
      dryRun,
      home,
      projectRoot,
      scope,
    };

    process.stdout.write(
      `rig install ${name} (${scopeLabel(scope, projectRoot)})${dryRun ? ' (dry run)' : ''}\n`,
    );
    if (scope !== requested) {
      process.stdout.write(
        scope === 'global'
          ? `  ${contract.display_name} has no project-level config — writing its user-level files instead.\n`
          : `  ${contract.display_name} has no user-level config — writing its project files instead.\n`,
      );
    }
    const result = await installTarget(contract, opts);
    process.stdout.write(`  detected: ${result.detected}\n`);
    for (const a of result.applied) {
      const mark = a.status === 'wrote' ? '✓' : a.status === 'dry-run' ? '~' : '·';
      process.stdout.write(
        `  ${mark} ${a.status.padEnd(9)} ${(a.role ?? a.mode).padEnd(12)} ${displayPath(a.path, projectRoot, home)}\n`,
      );
      if (a.reason) process.stdout.write(`      ${a.reason}\n`);
      if (a.note) process.stdout.write(`      note: ${a.note}\n`);
    }
    // Upgrading from user-wide wiring: say where the old entry still lives.
    if (scope === 'project') {
      for (const w of wiredLocations(contract, projectRoot, home).filter(
        (l) => l.scope === 'global',
      )) {
        process.stdout.write(
          `  note: rig is also wired user-wide in ${displayPath(w.path, projectRoot, home)} — ` +
            `\`rig uninstall ${name} --global\` removes that.\n`,
        );
      }
    }
  }
}
