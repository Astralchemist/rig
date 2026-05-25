// SPDX-License-Identifier: Apache-2.0
import type { TargetContract } from '@rig/contracts';
import claude from '../../../../.contracts/targets/claude.contract.ts';
import codex from '../../../../.contracts/targets/codex.contract.ts';
import cursor from '../../../../.contracts/targets/cursor.contract.ts';
import opencode from '../../../../.contracts/targets/opencode.contract.ts';
import openrouter from '../../../../.contracts/targets/openrouter.contract.ts';

const TARGETS: Record<string, TargetContract> = {
  claude,
  codex,
  cursor,
  opencode,
  openrouter,
};

export const getTarget = (name: string): TargetContract | null => TARGETS[name] ?? null;
export const allTargetNames = (): string[] => Object.keys(TARGETS);
