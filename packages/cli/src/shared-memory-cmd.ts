// SPDX-License-Identifier: Apache-2.0
// `rig memory <promote|unshare|import|check|list>`: memory that travels with
// the repo (backlog B5). Shared records live in .rig-memory/, committed.
import { execFileSync } from 'node:child_process';
import { Rig } from '@rig/core';
import {
  PromoteError,
  importShared,
  loadShared,
  promoteWaypoint,
  unshare,
} from '@rig/core/memory/shared.ts';

const author = (cwd: string): string => {
  try {
    return (
      execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf-8' }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
};

const USAGE = `usage: rig memory promote <waypoint-id> [--include-captured]
       rig memory unshare <id>
       rig memory import
       rig memory check        (exit 1 on malformed records, secrets or hidden Unicode)
       rig memory list
`;

export async function runMemory(cwd: string): Promise<void> {
  const [sub, arg] = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  const flag = (n: string): boolean => process.argv.includes(n);
  switch (sub) {
    case 'check': {
      const s = loadShared(cwd);
      for (const e of s.errors) process.stderr.write(`✗ ${e}\n`);
      process.stdout.write(
        `${s.records.size} shared, ${s.tombstoned.size} unshared, ${s.errors.length} problem(s)\n`,
      );
      process.exit(s.errors.length ? 1 : 0);
    }
    // falls through never: check exits
    case 'list': {
      const s = loadShared(cwd);
      for (const [id, r] of s.records)
        process.stdout.write(
          `${id}  v${r.version}  [${r.record.waypoint_kind}] ${r.record.title}  (by ${r.by})\n`,
        );
      return;
    }
    case 'unshare': {
      if (!arg) break;
      const v = unshare(cwd, arg, author(cwd));
      process.stdout.write(
        `unshared ${arg} (version ${v}); commit .rig-memory/ to share the change\n`,
      );
      return;
    }
    case 'promote':
    case 'import': {
      if (sub === 'promote' && !arg) break;
      const rig = await Rig.open(cwd);
      try {
        if (sub === 'promote') {
          try {
            const r = promoteWaypoint(rig, arg!, {
              by: author(cwd),
              includeCaptured: flag('--include-captured'),
            });
            process.stdout.write(
              `shared ${r.id} (version ${r.version}) in ${r.file}\ncommit it to share it with everyone on this repo\n`,
            );
          } catch (e) {
            if (e instanceof PromoteError) {
              for (const p of e.problems) process.stderr.write(`✗ not shared: ${p}\n`);
              process.exit(1);
            }
            throw e;
          }
        } else {
          const r = importShared(rig);
          for (const e of r.errors) process.stderr.write(`! ${e}\n`);
          process.stdout.write(
            `imported ${r.added}, removed ${r.removed} unshared, ${r.unanchored} waiting for symbols this index lacks\n`,
          );
        }
      } finally {
        rig.close();
      }
      return;
    }
  }
  process.stderr.write(USAGE);
  process.exit(2);
}
