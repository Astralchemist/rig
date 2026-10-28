// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MemoryFileError, Rig, RIG_DIR_NAME, type MemoryImportCounts } from '@rig/core';
// Static JSON import so bun --compile bundles the manifest into the binary.
import toolsManifest from '../../../generated/mcp/tools-manifest.json' with { type: 'json' };

// `rig export-memory` / `rig import-memory`: the agent-written memory as a
// JSONL file that survives losing .rig/ (packages/core/src/memory-file.ts has
// the format and the import rules).

const CONVERSATION_NOTE =
  'The file can contain conversation-derived text (waypoint summaries and payloads):\n' +
  'review it before you commit it anywhere.';

const requireInit = (cwd: string): void => {
  if (Rig.isInitialized(cwd)) return;
  console.error('rig: not initialized. Run `rig init` first.');
  process.exit(2);
};

// 2026-10-28T15:30:05.123Z → 20261028T153005Z
const utcStamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export const runExportMemory = async (cwd: string): Promise<void> => {
  requireInit(cwd);
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && (!out || out.startsWith('--'))) {
    console.error('rig: --out needs a file path');
    process.exit(2);
  }
  const path = out
    ? resolve(cwd, out)
    : join(resolve(cwd), RIG_DIR_NAME, 'exports', `memory-${utcStamp(new Date())}.jsonl`);
  const rig = await Rig.open(cwd);
  try {
    const { text, counts } = rig.exportMemory();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`rig: exported agent memory to ${path}`);
    for (const [type, n] of Object.entries(counts)) console.log(`  ${type.padEnd(14)} ${n}`);
    console.log(CONVERSATION_NOTE);
  } finally {
    rig.close();
  }
};

const summarize = (c: MemoryImportCounts): string =>
  [
    c.added ? `${c.added} added` : '',
    c.present ? `${c.present} already present` : '',
    c.orphaned ? `${c.orphaned} waiting in orphans` : '',
    c.dropped ? `${c.dropped} dropped` : '',
  ]
    .filter(Boolean)
    .join(', ');

export const runImportMemory = async (cwd: string): Promise<void> => {
  requireInit(cwd);
  const file = process.argv[3];
  if (!file || file.startsWith('--')) {
    console.error('usage: rig import-memory <file>');
    process.exit(2);
  }
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    console.error(`rig: ${path} not found`);
    process.exit(2);
  }
  const rig = await Rig.open(cwd);
  try {
    // Skill anchors are re-seeded, not imported: make sure references to them
    // resolve.
    rig.seedSkills((toolsManifest as { tools: Parameters<Rig['seedSkills']>[0] }).tools);
    const r = rig.importMemory(readFileSync(path, 'utf-8'));
    console.log(`rig: imported agent memory from ${path}`);
    for (const [type, c] of Object.entries(r.records)) {
      console.log(`  ${type.padEnd(14)} ${summarize(c)}`);
    }
    if (Object.values(r.records).some((c) => c.orphaned > 0)) {
      console.log(
        '  Memory of symbols not found here waits in orphaned memory (`rig status`) and\n' +
          '  re-attaches when they are indexed.',
      );
    }
    if (Object.values(r.records).some((c) => c.dropped > 0)) {
      console.log('  Dropped records refer to agent-written nodes that no longer exist.');
    }
  } catch (e) {
    if (!(e instanceof MemoryFileError)) throw e;
    console.error(`rig: ${path}: ${e.message}`);
    process.exit(2);
  } finally {
    rig.close();
  }
};
