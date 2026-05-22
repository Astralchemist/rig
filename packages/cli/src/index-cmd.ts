import { Rig } from '@rig/core';

export const runIndex = async (cwd: string): Promise<void> => {
  if (!Rig.isInitialized(cwd)) {
    console.error('rig: not initialized. Run `rig init` first.');
    process.exit(2);
  }
  const rig = await Rig.open(cwd);
  try {
    process.stdout.write('rig: indexing... ');
    const r = await rig.indexAll();
    console.log(`done`);
    console.log(`  files:            ${r.files}`);
    console.log(`  nodes:            ${r.nodes}`);
    console.log(`  elapsed:          ${r.elapsed_ms}ms`);
  } finally {
    rig.close();
  }
};
