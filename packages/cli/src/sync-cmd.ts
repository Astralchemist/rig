// SPDX-License-Identifier: Apache-2.0
import { Rig } from '@rig/core';

export async function runSync(cwd: string): Promise<void> {
  const rig = await Rig.open(cwd);
  try {
    const result = await rig.sync();
    const memory =
      result.orphaned || result.reattached
        ? ` (memory: ${result.orphaned} orphaned, ${result.reattached} re-attached)`
        : '';
    process.stdout.write(
      `synced: ${result.filesChanged} changed, ${result.filesPurged} purged in ${result.durationMs}ms${memory}\n`,
    );
    // Shared memory from .rig-memory/ (B5): whatever a pull brought in.
    const { importShared, describeImport } = await import('@rig/core/memory/shared.ts');
    const shared = describeImport(importShared(rig));
    if (shared) process.stdout.write(`${shared}\n`);
  } finally {
    rig.close();
  }
}
