import { applyFile, type ApplyResult, type TargetFileLike } from './modes.ts';
import type { TokenContext } from './tokens.ts';

export interface InstallOptions extends TokenContext {
  dryRun?: boolean | undefined;
  home?: string | undefined;
}

export interface InstallResult {
  target: string;
  detected: boolean;
  applied: ApplyResult[];
}

interface TargetLike {
  name: string;
  detect: () => Promise<boolean>;
  files: TargetFileLike[];
}

export async function installTarget(
  contract: TargetLike,
  opts: InstallOptions,
): Promise<InstallResult> {
  const detected = await contract.detect();
  const applied: ApplyResult[] = [];
  for (const file of contract.files) {
    applied.push(await applyFile(file, opts, { dryRun: opts.dryRun, home: opts.home }));
  }
  return { target: contract.name, detected, applied };
}
