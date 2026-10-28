// SPDX-License-Identifier: Apache-2.0
import { MAX_OVERVIEW_BUDGET, MIN_OVERVIEW_BUDGET, Rig } from '@rig/core';

const optionValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};

// `rig overview [--budget <tokens>] [--json]`: print the orientation map the
// agent gets from rig_overview / rig://overview.
export async function runOverview(cwd: string): Promise<void> {
  if (!Rig.isInitialized(cwd)) {
    console.error('rig: not initialized in this directory. Run `rig init` first.');
    process.exitCode = 1;
    return;
  }
  const raw = optionValue('--budget');
  const budget = raw === undefined ? undefined : Number(raw);
  if (
    budget !== undefined &&
    (!Number.isInteger(budget) || budget < MIN_OVERVIEW_BUDGET || budget > MAX_OVERVIEW_BUDGET)
  ) {
    console.error(
      `rig: --budget must be an integer from ${MIN_OVERVIEW_BUDGET} to ${MAX_OVERVIEW_BUDGET} (tokens)`,
    );
    process.exitCode = 2;
    return;
  }
  const rig = await Rig.open(cwd);
  try {
    const o = rig.overview(budget === undefined ? {} : { budget });
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(o, null, 2) + '\n');
      return;
    }
    process.stdout.write(o.map);
    process.stderr.write(
      `${o.chars.toLocaleString('en-US')} chars ≈ ${o.est_tokens.toLocaleString('en-US')} tokens ` +
        `(budget ${o.budget}); generated ${new Date(o.generated_at).toISOString()}` +
        `${o.cached ? ' (cached)' : ` in ${o.elapsed_ms} ms`}\n`,
    );
  } finally {
    rig.close();
  }
}
