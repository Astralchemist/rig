// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildFiles } from './gen.ts';
import { classifyCompat, type ToolEntry } from './gen/compat.ts';

const ROOT = resolve(import.meta.dir, '..');
const SNAPSHOT = join(ROOT, 'compat', 'tools-manifest.snapshot.json');

const builtManifest = async (): Promise<{ version: number; tools: ToolEntry[] }> => {
  const { files } = await buildFiles();
  const f = files.find((x) => x.path === 'mcp/tools-manifest.json');
  if (!f) throw new Error('no tools-manifest emitted');
  return JSON.parse(f.content);
};

const write = process.argv.includes('--write');
const current = await builtManifest();

if (write) {
  await mkdir(dirname(SNAPSHOT), { recursive: true });
  await writeFile(SNAPSHOT, JSON.stringify(current, null, 2) + '\n');
  console.log(`✓ compat: snapshot updated (${current.tools.length} tools)`);
  process.exit(0);
}

let baseRaw: string;
try {
  baseRaw = await readFile(SNAPSHOT, 'utf-8');
} catch {
  console.error('✗ compat: no snapshot. Run `bun run compat:snapshot` to bless the current surface.');
  process.exit(1);
}
const base = JSON.parse(baseRaw) as { version: number; tools: ToolEntry[] };

// A major manifest version bump is the sanctioned escape hatch for breaking changes.
const majorBump = Math.trunc(current.version) > Math.trunc(base.version);
const changes = classifyCompat(base.tools, current.tools);
const breaking = changes.filter((c) => c.severity === 'breaking');

if (breaking.length && !majorBump) {
  console.error(`✗ compat: ${breaking.length} breaking change(s) to stable tools:`);
  for (const c of breaking) console.error(`  ${c.tool}: ${c.detail}`);
  console.error('  → bump the manifest major version, mark the tool experimental, or revert.');
  console.error('  → if intentional, re-bless with `bun run compat:snapshot`.');
  process.exit(1);
}
console.log(`✓ compat: no breaking changes (${changes.length} change(s), ${breaking.length} breaking, majorBump=${majorBump})`);
