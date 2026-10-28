// SPDX-License-Identifier: Apache-2.0
// The tool surfaces under test. Every arm gets the same model, system prompt
// and query; only the tools differ.
import type { Rig } from '@rig/core';
import { BASELINE_TOOLS, runBaselineTool } from './tools-baseline.ts';
import { RIG_TOOLS, runRigTool } from './tools-rig.ts';
import { RIG_SEARCH_TOOLS, makeRigSearchRunner } from './tools-rig-search.ts';
import type { ArmName, ToolDef } from './types.ts';

export const ARM_NAMES: readonly ArmName[] = ['baseline', 'rig', 'rig-search'];

export interface Arm {
  name: ArmName;
  tools: readonly ToolDef[];
  exec(name: string, input: unknown): Promise<string>;
}

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
  name === 'baseline' ? BASELINE_TOOLS : name === 'rig' ? RIG_TOOLS : RIG_SEARCH_TOOLS;

export const makeArm = (name: ArmName, repoRoot: string, rig: Rig | null): Arm => {
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
  return { name, tools: RIG_SEARCH_TOOLS, exec: makeRigSearchRunner(rig) };
};
