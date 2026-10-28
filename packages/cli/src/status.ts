// SPDX-License-Identifier: Apache-2.0
import { Rig } from '@rig/core';

export const runStatus = async (cwd: string): Promise<void> => {
  if (!Rig.isInitialized(cwd)) {
    console.log('rig: not initialized in this directory. Run `rig init` first.');
    return;
  }
  const rig = await Rig.open(cwd);
  try {
    const s = await rig.status();
    console.log('rig: initialized');
    console.log(`  nodes:            ${s.nodes}`);
    console.log(`  edges_structural: ${s.edges_structural}`);
    console.log(`  edges_semantic:   ${s.edges_semantic}`);
    console.log(`  files:            ${s.files}`);
    console.log(`  last_sync_ts:     ${s.last_sync_ts ?? '(none)'}`);
    console.log(`  last_index_ts:    ${s.last_index_ts ?? '(none)'}`);
    console.log(`  orphans:          ${s.orphans}`);
  } finally {
    rig.close();
  }
};
