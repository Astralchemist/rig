// SPDX-License-Identifier: Apache-2.0
// The benchmark target and its index. The index is always built by the rig
// code of this checkout (workspace import, not an installed CLI), and stamped
// with a fingerprint of those sources so a different rig version rebuilds it
// instead of being measured against a stale graph.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Rig, RIG_DIR_NAME } from '@rig/core';
import manifestJson from '../../generated/mcp/tools-manifest.json' with { type: 'json' };
import type { RigVersion } from './types.ts';

export const RIG_ROOT = resolve(import.meta.dir, '../..');
const STAMP = 'bench-stamp.json';

// Everything that changes what gets indexed or what a tool returns.
const FINGERPRINT_DIRS = [
  'packages/core/src',
  'packages/mcp/src',
  'packages/contracts/src',
  '.contracts',
  'generated/mcp',
];

const git = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

export const gitHead = (dir: string): string | null => git(dir, ['rev-parse', 'HEAD']);

const walk = (dir: string, out: string[]): void => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
};

export const rigVersion = (root = RIG_ROOT): RigVersion => {
  const hash = createHash('sha256');
  for (const d of FINGERPRINT_DIRS) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    const files: string[] = [];
    walk(abs, files);
    for (const f of files) {
      hash.update(relative(root, f));
      hash.update('\0');
      hash.update(readFileSync(f));
      hash.update('\0');
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
  const status = git(root, ['status', '--porcelain']);
  return {
    version: pkg.version,
    commit: gitHead(root),
    dirty: status !== null && status !== '',
    fingerprint: hash.digest('hex').slice(0, 16),
  };
};

export type IndexState = 'missing' | 'current' | 'stale' | 'foreign';

interface Stamp {
  fingerprint: string;
  rig_commit: string | null;
  built_at: string;
}

const stampPath = (repo: string): string => join(repo, RIG_DIR_NAME, STAMP);

// foreign = a .rig the bench didn't build; it may hold someone's waypoints,
// so the bench never deletes it without --fresh-index.
export const indexState = (repo: string, fingerprint: string): IndexState => {
  if (!Rig.isInitialized(repo)) return 'missing';
  if (!existsSync(stampPath(repo))) return 'foreign';
  try {
    const s = JSON.parse(readFileSync(stampPath(repo), 'utf-8')) as Stamp;
    return s.fingerprint === fingerprint ? 'current' : 'stale';
  } catch {
    return 'foreign';
  }
};

export interface PreparedIndex {
  rig: Rig;
  rebuilt: boolean;
  elapsed_ms: number;
  nodes: number;
  files: number;
}

export const prepareIndex = async (
  repo: string,
  version: RigVersion,
  opts: { fresh: boolean; log: (line: string) => void },
): Promise<PreparedIndex> => {
  const state = indexState(repo, version.fingerprint);
  if (state === 'foreign' && !opts.fresh) {
    throw new Error(
      `${repo}/${RIG_DIR_NAME} was not built by the bench. Pass --fresh-index to replace it.`,
    );
  }
  const t0 = Date.now();
  if (state === 'current' && !opts.fresh) {
    const rig = await Rig.open(repo);
    const s = await rig.status();
    opts.log(`index: reusing (${s.nodes} nodes, ${s.files} files, rig ${version.fingerprint})`);
    return { rig, rebuilt: false, elapsed_ms: 0, nodes: s.nodes, files: s.files };
  }
  if (state !== 'missing') rmSync(join(repo, RIG_DIR_NAME), { recursive: true, force: true });
  opts.log(`index: building with rig ${version.version} (${version.fingerprint})...`);
  const rig = await Rig.init(repo);
  await rig.indexAll();
  // As `rig index` does: tool skills become anchors that search can return.
  rig.seedSkills((manifestJson as { tools: Parameters<Rig['seedSkills']>[0] }).tools);
  const s = await rig.status();
  const stamp: Stamp = {
    fingerprint: version.fingerprint,
    rig_commit: version.commit,
    built_at: new Date().toISOString(),
  };
  writeFileSync(stampPath(repo), JSON.stringify(stamp, null, 2) + '\n');
  const elapsed = Date.now() - t0;
  opts.log(`index: built ${s.nodes} nodes, ${s.files} files in ${(elapsed / 1000).toFixed(1)}s`);
  return { rig, rebuilt: true, elapsed_ms: elapsed, nodes: s.nodes, files: s.files };
};
