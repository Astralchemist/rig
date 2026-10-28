// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };

const PKG_NAME = 'rig-constellation';
const REGISTRY = `https://registry.npmjs.org/${PKG_NAME}/latest`;

// Compare two dotted version strings. Returns true when `b` is strictly newer
// than `a`. Numeric-only compare is enough for our 0.x line; a prerelease
// suffix on an otherwise-equal version is treated as older.
export const isNewer = (a: string, b: string): boolean => {
  const part = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [part(a), part(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (y !== x) return y > x;
  }
  return false; // equal core → not newer (ignores prerelease ordering)
};

// Local install if the package resolves under the current project's
// node_modules; otherwise assume a global install. Drives `npm i` vs `npm i -g`.
const isLocalInstall = (cwd: string): boolean =>
  existsSync(join(cwd, 'node_modules', PKG_NAME, 'package.json'));

const fetchLatest = async (): Promise<string | null> => {
  try {
    const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
};

export async function runUpdate(cwd: string): Promise<void> {
  const current = (pkg as { version: string }).version;
  const checkOnly = process.argv.includes('--check') || process.argv.includes('-n');

  const latest = await fetchLatest();
  if (!latest) {
    console.error(`rig update: couldn't reach the npm registry (you're on ${current}). Check your connection.`);
    process.exitCode = 1;
    return;
  }

  if (!isNewer(current, latest)) {
    console.log(`✓ rig ${current} is the latest.`);
    return;
  }

  const local = isLocalInstall(cwd);
  const args = local ? ['i', `${PKG_NAME}@latest`] : ['i', '-g', `${PKG_NAME}@latest`];
  const cmd = `npm ${args.join(' ')}`;
  console.log(`rig ${current} installed · ${latest} available`);
  console.log(`  ${local ? 'local' : 'global'} install → ${cmd}`);

  if (checkOnly) {
    console.log('  (run `rig update` without --check to apply)');
    return;
  }

  console.log('  updating…\n');
  const res = spawnSync('npm', args, { stdio: 'inherit', cwd: local ? cwd : undefined });
  if (res.status !== 0) {
    console.error(`\nrig update: \`${cmd}\` failed (exit ${res.status ?? '?'}). Run it manually.`);
    process.exitCode = res.status ?? 1;
    return;
  }
  console.log(`\n✓ updated to ${PKG_NAME}@${latest}.`);
}
