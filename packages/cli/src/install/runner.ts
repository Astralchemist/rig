// SPDX-License-Identifier: Apache-2.0
import { applyFile, type ApplyResult, type TargetFileLike } from './modes.ts';
import { scopeOf, type Scope } from './paths.ts';
import type { TokenContext } from './tokens.ts';

export interface InstallOptions extends TokenContext {
  dryRun?: boolean | undefined;
  home?: string | undefined;
  // Root for project-scoped files; defaults to the process cwd.
  projectRoot?: string | undefined;
  // Which of the target's files to write; defaults to 'project'.
  scope?: Scope | undefined;
}

export interface InstallResult {
  target: string;
  detected: boolean;
  scope: Scope;
  applied: ApplyResult[];
}

export interface TargetLike {
  name: string;
  detect: () => Promise<boolean>;
  files: TargetFileLike[];
}

export const filesInScope = <F extends { path: string }>(
  contract: { files: F[] },
  scope: Scope,
): F[] => contract.files.filter((f) => scopeOf(f.path) === scope);

export const hasScope = (contract: { files: { path: string }[] }, scope: Scope): boolean =>
  filesInScope(contract, scope).length > 0;

export async function installTarget(
  contract: TargetLike,
  opts: InstallOptions,
): Promise<InstallResult> {
  const scope = opts.scope ?? 'project';
  const detected = await contract.detect();
  const applied: ApplyResult[] = [];
  for (const file of filesInScope(contract, scope)) {
    applied.push(
      await applyFile(file, opts, {
        dryRun: opts.dryRun,
        home: opts.home,
        projectRoot: opts.projectRoot,
      }),
    );
  }
  return { target: contract.name, detected, scope, applied };
}
