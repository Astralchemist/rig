// SPDX-License-Identifier: Apache-2.0
import type { GeneratedFile, LoadedContract } from './types.ts';

// The repo dogfoods its own Cursor rule: .cursor/rules/rig.mdc is exactly what
// `rig install cursor` writes, rendered from the same generated instructions,
// so `bun run gen` keeps it from drifting (it once froze at 10 tools).
export const REPO_CURSOR_RULE = '.cursor/rules/rig.mdc';

const GENERATED_TOKEN = /\{\{GENERATED:([^}]+)\}\}/g;

export const emitRepoFiles = (
  targets: LoadedContract<'targets'>[],
  generated: GeneratedFile[],
): GeneratedFile[] => {
  const cursor = targets.find((t) => t.data.name === 'cursor');
  const rule = cursor?.data.files.find((f) => f.path === REPO_CURSOR_RULE);
  if (!cursor || !rule || typeof rule.template !== 'string') return [];
  const content = rule.template.replace(GENERATED_TOKEN, (_, name: string) => {
    const file = generated.find((g) => g.path === `installer/${name}`);
    if (!file) throw new Error(`${REPO_CURSOR_RULE}: no generated installer/${name}`);
    return file.content;
  });
  return [{ path: REPO_CURSOR_RULE, content, source: [cursor.file] }];
};
