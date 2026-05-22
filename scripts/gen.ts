import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { byKind, discoverContracts } from './gen/discover.ts';
import { computeManifest } from './gen/manifest.ts';
import { emitAnchorRegistry } from './gen/emitters/anchor.ts';
import { emitEventTypes } from './gen/emitters/event.ts';
import { emitMigrations } from './gen/emitters/migration.ts';
import { emitTargetArtifacts } from './gen/emitters/target.ts';
import {
  emitToolHandlerStubs,
  emitToolNamesIndex,
  emitToolsManifest,
} from './gen/emitters/tool.ts';
import type { GeneratedFile, LoadedContract } from './gen/types.ts';

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'generated');

export async function buildFiles(): Promise<{
  files: GeneratedFile[];
  elapsedMs: number;
}> {
  const start = Date.now();
  const all = await discoverContracts(ROOT);

  const tools = byKind(all, 'tools');
  const anchors = byKind(all, 'anchors');
  const targets = byKind(all, 'targets');
  const migrations = byKind(all, 'migrations');
  const events = byKind(all, 'events');

  assertUniqueByName(tools, 'tool', (c) => c.data.name);
  assertUniqueByName(anchors, 'anchor', (c) => c.data.type);
  assertUniqueByName(targets, 'target', (c) => c.data.name);
  assertContiguousMigrations(migrations);

  const files: GeneratedFile[] = [];
  if (tools.length) {
    files.push(emitToolsManifest(tools));
    files.push(...emitToolHandlerStubs(tools));
    files.push(emitToolNamesIndex(tools));
  }
  if (anchors.length) files.push(emitAnchorRegistry(anchors));
  if (targets.length) files.push(...emitTargetArtifacts(targets, tools));
  if (migrations.length) files.push(...emitMigrations(migrations));
  if (events.length) files.push(emitEventTypes(events));

  return { files, elapsedMs: Date.now() - start };
}

const assertUniqueByName = <K extends 'tools' | 'anchors' | 'targets'>(
  items: LoadedContract<K>[],
  label: string,
  keyOf: (c: LoadedContract<K>) => string,
): void => {
  const seen = new Map<string, string>();
  for (const it of items) {
    const k = keyOf(it);
    const prior = seen.get(k);
    if (prior) throw new Error(`Duplicate ${label} '${k}' in ${prior} and ${it.file}`);
    seen.set(k, it.file);
  }
};

const assertContiguousMigrations = (migrations: LoadedContract<'migrations'>[]): void => {
  const versions = migrations.map((m) => m.data.version).toSorted((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new Error(`Migration versions must be contiguous from 1; got [${versions.join(', ')}]`);
    }
  }
};

if (import.meta.main) {
  const { files, elapsedMs } = await buildFiles();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const f of files) {
    const out = join(OUT, f.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, f.content);
  }
  const manifest = computeManifest(files);
  await writeFile(join(OUT, '.manifest'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ gen: ${files.length} files in ${elapsedMs}ms`);
}
