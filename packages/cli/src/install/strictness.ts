// SPDX-License-Identifier: Apache-2.0

// Re-installing never loosens a per-tool rule the user made stricter. Claude
// Code and the Cursor CLI get this from list unions (deny > ask > allow);
// hosts with one value per tool get the stricter of the two values instead:
//   opencode  allow < ask < deny
//   codex     approve < auto | writes < prompt
const RANK: Record<string, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
  approve: 0,
  auto: 1,
  writes: 1,
  prompt: 2,
};

export const stricter = (existing: unknown, incoming: unknown): unknown => {
  if (typeof existing !== 'string' || typeof incoming !== 'string') return incoming;
  const a = RANK[existing];
  const b = RANK[incoming];
  if (a === undefined || b === undefined || existing === incoming) return incoming;
  // Codex's auto and writes can each ask where the other wouldn't; their
  // conservative meet is prompt (AppToolApproval::restrict_to).
  if (a === b) return 'prompt';
  return a > b ? existing : incoming;
};
