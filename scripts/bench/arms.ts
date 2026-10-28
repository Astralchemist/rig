// SPDX-License-Identifier: Apache-2.0
// The tool surfaces under test. Every arm gets the same model, system prompt
// and query; only the tools differ, except grep+rig+map, which adds rig's
// repository overview to the system prompt.
import type { Rig } from '@rig/core';
import { BASELINE_TOOLS, runBaselineTool } from './tools-baseline.ts';
import { RIG_TOOLS, runRigTool } from './tools-rig.ts';
import { RIG_SEARCH_TOOLS, makeRigSearchRunner } from './tools-rig-search.ts';
import { SYSTEM_PROMPT } from './agent.ts';
import type { ArmName, ToolDef } from './types.ts';

export const ARM_NAMES: readonly ArmName[] = [
  'baseline',
  'rig',
  'rig-search',
  'grep+rig',
  'grep+rig+map',
];

// Arms that hand the model ripgrep.
export const GREP_ARMS: readonly ArmName[] = ['baseline', 'grep+rig', 'grep+rig+map'];

// Arms whose system prompt carries the repository overview.
export const MAP_ARMS: readonly ArmName[] = ['grep+rig+map'];

// grep+rig is what an agent has in real use: the baseline tools to read
// source, plus the rig-search tools through the same real-handler path. No
// routing hint; the model picks.
export const GREP_RIG_TOOLS: readonly ToolDef[] = [...BASELINE_TOOLS, ...RIG_SEARCH_TOOLS];
const BASELINE_NAMES = new Set(BASELINE_TOOLS.map((t) => t.name));

export interface Arm {
  name: ArmName;
  tools: readonly ToolDef[];
  // The system prompt, when it is not the shared SYSTEM_PROMPT.
  system?: string;
  exec(name: string, input: unknown): Promise<string>;
}

// grep+rig+map's system prompt: the shared prompt unchanged, then the map in
// a clearly delimited block. Nothing else differs from grep+rig.
export const OVERVIEW_BEGIN = '<repository-overview>';
export const OVERVIEW_END = '</repository-overview>';
export const systemWithOverview = (map: string): string =>
  `${SYSTEM_PROMPT}\n\nRepository overview, generated from an index of this repository:\n` +
  `${OVERVIEW_BEGIN}\n${map.trimEnd()}\n${OVERVIEW_END}`;

export const parseArms = (raw: string | undefined): ArmName[] => {
  if (raw === undefined) return [...ARM_NAMES];
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!ARM_NAMES.includes(n as ArmName)) {
      throw new Error(`unknown arm "${n}" (expected ${ARM_NAMES.join(', ')})`);
    }
  }
  if (names.length === 0) throw new Error('--arms is empty');
  return [...new Set(names)] as ArmName[];
};

export const armTools = (name: ArmName): readonly ToolDef[] =>
  name === 'baseline'
    ? BASELINE_TOOLS
    : name === 'rig'
      ? RIG_TOOLS
      : name === 'rig-search'
        ? RIG_SEARCH_TOOLS
        : GREP_RIG_TOOLS;

// `overview` is the map grep+rig+map puts in its system prompt.
export const makeArm = (
  name: ArmName,
  repoRoot: string,
  rig: Rig | null,
  opts: { overview?: string } = {},
): Arm => {
  if (name === 'baseline') {
    return {
      name,
      tools: BASELINE_TOOLS,
      exec: async (tool, input) => runBaselineTool(repoRoot, tool, input),
    };
  }
  if (!rig) throw new Error(`arm ${name} needs an indexed rig`);
  if (name === 'rig') {
    return { name, tools: RIG_TOOLS, exec: async (tool, input) => runRigTool(rig, tool, input) };
  }
  const rigSearch = makeRigSearchRunner(rig);
  if (name === 'rig-search') return { name, tools: RIG_SEARCH_TOOLS, exec: rigSearch };
  const grepRig: Arm = {
    name,
    tools: GREP_RIG_TOOLS,
    exec: async (tool, input) =>
      BASELINE_NAMES.has(tool) ? runBaselineTool(repoRoot, tool, input) : rigSearch(tool, input),
  };
  if (name === 'grep+rig') return grepRig;
  if (opts.overview === undefined) throw new Error(`arm ${name} needs the repository overview`);
  return { ...grepRig, system: systemWithOverview(opts.overview) };
};
