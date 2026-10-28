// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic.ts';
import { deepMerge, permissionsUnion, type MergeOptions } from './json-merge.ts';
import { mergeJsonc } from './jsonc-merge.ts';
import { expandRelativeTo } from './paths.ts';
import { upsertSection, upsertSectionSafe } from './section.ts';
import { expandTokens, type TokenContext } from './tokens.ts';
import { buildTomlTable, flattenSingleTable, upsertTomlTable } from './toml.ts';

export interface TargetFileLike {
  role: string;
  path: string;
  mode: string;
  template: unknown;
  section_marker?: string | undefined;
  note?: string | undefined;
}

export interface ApplyResult {
  path: string;
  mode: string;
  role?: string;
  changed: boolean;
  status: 'wrote' | 'unchanged' | 'dry-run' | 'skipped-unimplemented';
  reason?: string;
  note?: string;
}

export interface ApplyOptions {
  dryRun?: boolean | undefined;
  home?: string | undefined;
  // Base for project-scoped (non-`~/`) paths; defaults to the process cwd.
  projectRoot?: string | undefined;
}

const readOrEmpty = async (path: string): Promise<string> =>
  existsSync(path) ? readFile(path, 'utf-8') : '';

const applyMergeJson = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
  merge: MergeOptions,
): Promise<ApplyResult> => {
  const existing = await readOrEmpty(resolvedPath);
  const base = existing ? (JSON.parse(existing) as unknown) : {};
  const merged = deepMerge(base, template, merge);
  const next = JSON.stringify(merged, null, 2) + '\n';
  if (existing === next) {
    return { path: resolvedPath, mode: 'merge-json', changed: false, status: 'unchanged' };
  }
  if (!dryRun) await atomicWrite(resolvedPath, next);
  return {
    path: resolvedPath,
    mode: 'merge-json',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};

const applyAppendSection = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  const body = typeof template === 'string' ? template : JSON.stringify(template, null, 2);
  const existing = await readOrEmpty(resolvedPath);
  const { content: next, hadUserEdits, previousBody } = upsertSectionSafe(existing, body);
  if (existing === next) {
    return { path: resolvedPath, mode: 'append-section', changed: false, status: 'unchanged' };
  }
  if (!dryRun) {
    // Preserve any user edits that lived between our markers — drop them in a
    // .rig-backup sibling so they can be diffed/restored. Without this, a regen
    // would silently clobber custom instructions.
    if (hadUserEdits && previousBody) {
      const backup = `${resolvedPath}.rig-backup`;
      await atomicWrite(
        backup,
        `# Saved by rig install on ${new Date().toISOString()} — content between ` +
          `<!-- rig:begin --> markers that differed from the generated body.\n\n${previousBody}\n`,
      );
      process.stderr.write(
        `  warn: preserved your edits inside the rig section at ${backup}\n`,
      );
    }
    await atomicWrite(resolvedPath, next);
  }
  return {
    path: resolvedPath,
    mode: 'append-section',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};

void upsertSection; // re-exported elsewhere; keep the import live for typecheck.

export async function applyFile(
  file: TargetFileLike,
  ctx: TokenContext,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const resolvedPath = expandRelativeTo(file.path, opts.projectRoot ?? process.cwd(), opts.home);
  const template = await expandTokens(file.template, ctx);
  const result = await applyMode(file, resolvedPath, template, !!opts.dryRun);
  return { ...result, role: file.role, ...(file.note ? { note: file.note } : {}) };
}

const applyMode = async (
  file: TargetFileLike,
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  if (file.mode === 'merge-json') {
    // Permission lists are unioned so re-installs keep user-added entries (#8).
    const merge = file.role === 'permissions' ? { union: permissionsUnion } : {};
    return applyMergeJson(resolvedPath, template, dryRun, merge);
  }
  if (file.mode === 'append-section') return applyAppendSection(resolvedPath, template, dryRun);
  if (file.mode === 'replace') return applyReplace(resolvedPath, template, dryRun);
  if (file.mode === 'write-toml') return applyWriteToml(resolvedPath, template, dryRun);
  if (file.mode === 'merge-jsonc') return applyMergeJsonc(resolvedPath, template, dryRun);

  return {
    path: resolvedPath,
    mode: file.mode,
    changed: false,
    status: 'skipped-unimplemented',
    reason: `mode '${file.mode}' is not implemented`,
  };
};

const applyMergeJsonc = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  const existing = await readOrEmpty(resolvedPath);
  const next = mergeJsonc(existing, template);
  if (existing === next) {
    return { path: resolvedPath, mode: 'merge-jsonc', changed: false, status: 'unchanged' };
  }
  if (!dryRun) await atomicWrite(resolvedPath, next);
  return {
    path: resolvedPath,
    mode: 'merge-jsonc',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};

const applyReplace = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  const body = typeof template === 'string' ? template : JSON.stringify(template, null, 2);
  const existing = await readOrEmpty(resolvedPath);
  if (existing === body) {
    return { path: resolvedPath, mode: 'replace', changed: false, status: 'unchanged' };
  }
  if (!dryRun) await atomicWrite(resolvedPath, body);
  return {
    path: resolvedPath,
    mode: 'replace',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};

const applyWriteToml = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  if (!template || typeof template !== 'object') {
    throw new Error('write-toml template must be an object');
  }
  const { header, body } = flattenSingleTable(template as Record<string, unknown>);
  const block = buildTomlTable(header, body);
  const existing = await readOrEmpty(resolvedPath);
  const result = upsertTomlTable(existing, header, block);
  if (result.action === 'unchanged') {
    return { path: resolvedPath, mode: 'write-toml', changed: false, status: 'unchanged' };
  }
  if (!dryRun) await atomicWrite(resolvedPath, result.content);
  return {
    path: resolvedPath,
    mode: 'write-toml',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};
