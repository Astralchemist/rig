import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Resolve the directory that holds Rig's shipped runtime assets (generated/,
// packages/web/dist). This works in both layouts:
//   • dev   — running from packages/<pkg>/src, ascends to the repo root
//   • prod  — running from the bundled dist/, ascends to node_modules/rig
// We ascend from `fromDir` to the nearest ancestor containing
// `generated/installer` (present in both layouts), so code that loads assets
// doesn't have to hard-code a relative depth that bundling would invalidate.
export const findAssetRoot = (fromDir: string): string => {
  let dir = fromDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'generated', 'installer'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fromDir;
};
