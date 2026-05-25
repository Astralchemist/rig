// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { Glob } from 'bun';
import {
  anchorContractSchema,
  eventContractSchema,
  migrationContractSchema,
  targetContractSchema,
  toolContractSchema,
  type ContractKind,
} from '@rig/contracts';
import type { LoadedContract } from './types.ts';

const SCHEMAS = {
  tools: toolContractSchema,
  anchors: anchorContractSchema,
  targets: targetContractSchema,
  migrations: migrationContractSchema,
  events: eventContractSchema,
} as const;

const inferKind = (relPath: string): ContractKind | null => {
  const m = relPath.match(/^\.contracts\/(tools|anchors|targets|migrations|events)\//);
  return (m?.[1] as ContractKind) ?? null;
};

export async function discoverContracts(root: string): Promise<LoadedContract[]> {
  const glob = new Glob('.contracts/**/*.contract.ts');
  const out: LoadedContract[] = [];
  for await (const file of glob.scan({ cwd: root, dot: true })) {
    const kind = inferKind(file);
    if (!kind) continue;
    const absFile = resolve(root, file);
    const mod = (await import(absFile)) as { default?: unknown };
    if (!mod.default) throw new Error(`${file}: missing default export`);
    const result = SCHEMAS[kind].safeParse(mod.default);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`${file}: contract validation failed\n${issues}`);
    }
    const basename = file.split('/').at(-1)!.replace(/\.contract\.ts$/, '');
    out.push({ kind, file, absFile, basename, data: result.data as never });
  }
  // Sort by path (code-unit order) so codegen is deterministic across machines
  // — Glob.scan yields filesystem order, which differs between dev and CI.
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

export const byKind = <K extends ContractKind>(
  all: LoadedContract[],
  kind: K,
): LoadedContract<K>[] => all.filter((c): c is LoadedContract<K> => c.kind === kind);
