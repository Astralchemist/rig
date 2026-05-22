import { Rig } from '@rig/core';

export async function runSync(cwd: string): Promise<void> {
  const rig = await Rig.open(cwd);
  try {
    const result = await rig.sync();
    process.stdout.write(
      `synced: ${result.filesChanged} changed, ${result.filesPurged} purged in ${result.durationMs}ms\n`,
    );
  } finally {
    rig.close();
  }
}
