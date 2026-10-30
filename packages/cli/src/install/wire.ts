// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import type { TargetContract } from '@rig/contracts';
import { allTargetNames, getTarget } from './loader.ts';
import { displayPath, samePath } from './paths.ts';
import { hasScope, installTarget, type InstallResult } from './runner.ts';
import type { TokenContext } from './tokens.ts';
import { wiredLocations } from './uninstall.ts';

export interface WireOptions extends TokenContext {
  projectRoot: string;
  home?: string | undefined;
  // Host detection; defaults to each contract's detect(). Tests inject one.
  detect?: ((target: TargetContract) => Promise<boolean>) | undefined;
  // File roles to leave out (`rig start --no-hooks`).
  skipRoles?: readonly string[] | undefined;
}

export interface WireReport {
  wired: InstallResult[];
  // Detected agents whose rig config is user-level only (Codex, opencode).
  userLevelOnly: string[];
  // Wired agents that an older, user-wide install also still wires.
  alsoUserLevel: Array<{ target: string; paths: string[] }>;
  // The project root is $HOME, where project files would be user config.
  skippedHome: boolean;
}

// `rig start` wires every detected agent at project scope and never writes
// user-level config: agents rig can only wire user-wide are reported instead,
// so the user opts in with `rig install <name>`.
export const wireDetectedAgents = async (opts: WireOptions): Promise<WireReport> => {
  const home = opts.home ?? homedir();
  const report: WireReport = {
    wired: [],
    userLevelOnly: [],
    alsoUserLevel: [],
    skippedHome: false,
  };
  if (samePath(opts.projectRoot, home)) return { ...report, skippedHome: true };
  const detect = opts.detect ?? ((t: TargetContract) => t.detect());
  for (const name of allTargetNames()) {
    const contract = getTarget(name);
    if (!contract || !(await detect(contract))) continue;
    if (!hasScope(contract, 'project')) {
      report.userLevelOnly.push(name);
      continue;
    }
    report.wired.push(
      await installTarget(contract, {
        rigBin: opts.rigBin,
        generatedDir: opts.generatedDir,
        projectRoot: opts.projectRoot,
        home,
        scope: 'project',
        dryRun: false,
        ...(opts.skipRoles ? { skipRoles: opts.skipRoles } : {}),
      }),
    );
    const userLevel = wiredLocations(contract, opts.projectRoot, home).filter(
      (w) => w.scope === 'global',
    );
    if (userLevel.length)
      report.alsoUserLevel.push({ target: name, paths: userLevel.map((w) => w.path) });
  }
  return report;
};

export interface WireLine {
  ok: boolean;
  label: string;
  detail: string;
  // One line per file: its status and path, then any notes.
  files: string[];
}

const nameOf = (target: string): string => getTarget(target)?.display_name ?? target;

// Every file rig touched, with what happened to it — `rig start` prints these.
export const describeWiring = (
  report: WireReport,
  projectRoot: string,
  home: string = homedir(),
): WireLine[] => {
  if (report.skippedHome) {
    return [
      {
        ok: false,
        label: 'not wiring agents',
        detail: 'this is your home directory — `rig install <target> --global` wires user-wide',
        files: [],
      },
    ];
  }
  const out: WireLine[] = report.wired.map((w) => ({
    ok: true,
    label: `wired ${nameOf(w.target)}`,
    detail: 'project',
    files: [
      ...w.applied.map((a) => `${a.status.padEnd(9)} ${displayPath(a.path, projectRoot, home)}`),
      ...w.applied.filter((a) => a.note && a.changed).map((a) => `note      ${a.note}`),
      ...(report.alsoUserLevel.find((u) => u.target === w.target)?.paths ?? []).map(
        (p) =>
          `note      also wired user-wide in ${displayPath(p, projectRoot, home)} — ` +
          `\`rig uninstall ${w.target} --global\` removes that`,
      ),
    ],
  }));
  for (const name of report.userLevelOnly) {
    out.push({
      ok: false,
      label: `${nameOf(name)} detected`,
      detail: `rig wires it user-wide only — run \`rig install ${name}\` to opt in`,
      files: [],
    });
  }
  if (!out.length) {
    out.push({
      ok: false,
      label: 'no agents detected',
      detail: 'run `rig install <target>` later',
      files: [],
    });
  }
  return out;
};
