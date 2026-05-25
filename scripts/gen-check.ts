// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildFiles } from './gen.ts';
import { computeManifest, diffManifests, type Manifest } from './gen/manifest.ts';

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'generated');

const readDiskManifest = async (): Promise<Manifest | null> => {
  try {
    const raw = await readFile(join(OUT, '.manifest'), 'utf-8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
};

const disk = await readDiskManifest();
if (!disk) {
  console.error('✗ generated/.manifest missing — run `bun run gen`');
  process.exit(1);
}

const { files } = await buildFiles();
const fresh = computeManifest(files);
const diff = diffManifests(disk, fresh);

if (diff.length) {
  console.error('✗ generated/ is stale. Run `bun run gen`.');
  for (const d of diff) console.error(`  ${d.kind.padEnd(8)} ${d.path}`);
  process.exit(1);
}
console.log('✓ generated/ is fresh');
