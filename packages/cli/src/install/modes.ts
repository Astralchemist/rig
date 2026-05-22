import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic.ts';
import { deepMerge } from './json-merge.ts';
import { expandHome } from './paths.ts';
import { upsertSection } from './section.ts';
import { expandTokens, type TokenContext } from './tokens.ts';

export interface TargetFileLike {
  role: string;
  path: string;
  mode: string;
  template: unknown;
  section_marker?: string | undefined;
}

export interface ApplyResult {
  path: string;
  mode: string;
  changed: boolean;
  status: 'wrote' | 'unchanged' | 'dry-run' | 'skipped-unimplemented';
  reason?: string;
}

const readOrEmpty = async (path: string): Promise<string> =>
  existsSync(path) ? readFile(path, 'utf-8') : '';

const applyMergeJson = async (
  resolvedPath: string,
  template: unknown,
  dryRun: boolean,
): Promise<ApplyResult> => {
  const existing = await readOrEmpty(resolvedPath);
  const base = existing ? (JSON.parse(existing) as unknown) : {};
  const merged = deepMerge(base, template);
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
  const next = upsertSection(existing, body);
  if (existing === next) {
    return { path: resolvedPath, mode: 'append-section', changed: false, status: 'unchanged' };
  }
  if (!dryRun) await atomicWrite(resolvedPath, next);
  return {
    path: resolvedPath,
    mode: 'append-section',
    changed: true,
    status: dryRun ? 'dry-run' : 'wrote',
  };
};

export async function applyFile(
  file: TargetFileLike,
  ctx: TokenContext,
  opts: { dryRun?: boolean | undefined } = {},
): Promise<ApplyResult> {
  const dryRun = !!opts.dryRun;
  const resolvedPath = expandHome(file.path);
  const template = await expandTokens(file.template, ctx);

  if (file.mode === 'merge-json') return applyMergeJson(resolvedPath, template, dryRun);
  if (file.mode === 'append-section') return applyAppendSection(resolvedPath, template, dryRun);
  if (file.mode === 'replace') return applyReplace(resolvedPath, template, dryRun);

  return {
    path: resolvedPath,
    mode: file.mode,
    changed: false,
    status: 'skipped-unimplemented',
    reason: `mode '${file.mode}' lands in a follow-up (Codex TOML / opencode JSONC)`,
  };
}

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
