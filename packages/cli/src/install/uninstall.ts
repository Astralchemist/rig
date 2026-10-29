// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { atomicWrite } from './atomic.ts';
import type { TargetFileLike } from './modes.ts';
import { stripRigHooks } from './json-merge.ts';
import { isRigListEntry, isRigMapKey, isRigToolTable } from './ownership.ts';
import { expandRelativeTo, type Scope } from './paths.ts';
import { filesInScope } from './runner.ts';
import { removeSection } from './section.ts';
import { expandTokens, type TokenContext } from './tokens.ts';
import { flattenTables, listTomlTables, removeTomlKeys, removeTomlTableTree } from './toml.ts';

// `rig uninstall` removes exactly what `rig install` adds, file by file:
//   mcp_config    the rig server entry (mcpServers.rig, mcp.rig, [mcp_servers.rig…])
//   permissions   rig-owned entries (ownership.ts), from whichever list holds them
//   instructions  the section between rig's markers, or rig's generated rule file
//   hooks         rig's hook handlers (`rig hook …` commands), from every event
// Everything else in a file is left alone. A file that held nothing but rig's
// content is deleted, and in project scope so is a directory that emptied.

// The MCP server name every target registers rig under.
const SERVER = 'rig';
const RIG_GENERATED_MARK = 'GENERATED FILE — DO NOT EDIT';

export type RemoveStatus = 'removed' | 'deleted' | 'absent' | 'kept';

export interface RemoveResult {
  path: string;
  role: string;
  mode: string;
  status: RemoveStatus;
  detail: string;
}

export interface UninstallResult {
  target: string;
  scope: Scope;
  removed: RemoveResult[];
}

export interface UninstallOptions extends TokenContext {
  scope?: Scope | undefined;
  // Only these roles' files (install --no-hooks removes just the hooks).
  roles?: readonly string[] | undefined;
  projectRoot?: string | undefined;
  home?: string | undefined;
  dryRun?: boolean | undefined;
}

interface TargetFiles {
  name: string;
  files: TargetFileLike[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// Paths in a template to the rig server entry (an object under a `rig` key).
const serverPaths = (template: unknown, prefix: string[] = []): string[][] => {
  if (!isObj(template)) return [];
  return Object.entries(template).flatMap(([k, v]) =>
    k === SERVER && isObj(v) ? [[...prefix, k]] : serverPaths(v, [...prefix, k]),
  );
};

// Every list directly inside the objects the template names — the whole
// `permissions` object, deny included: [path, entries].
const listsUnder = (doc: Json, template: unknown): Array<[string[], unknown[]]> => {
  if (!isObj(template)) return [];
  return Object.keys(template).flatMap((k) => {
    const container = doc[k];
    if (!isObj(container)) return [];
    return Object.entries(container)
      .filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
      .map(([list, entries]): [string[], unknown[]] => [[k, list], entries]);
  });
};

// rig-owned keys in `doc` under the template's top-level objects (opencode's
// `permission`), including keys for tools rig no longer ships.
const ownedKeysUnder = (doc: unknown, template: unknown): string[][] => {
  if (!isObj(doc) || !isObj(template)) return [];
  return Object.keys(template).flatMap((k) => {
    const v = doc[k];
    return isObj(v) ? Object.keys(v).filter(isRigMapKey).map((kk) => [k, kk]) : [];
  });
};

const getAt = (doc: unknown, path: readonly string[]): unknown => {
  let cur = doc;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};

// Delete doc[path], then any ancestor object the deletion left empty.
const deleteAt = (doc: Json, path: readonly string[]): boolean => {
  const chain: Json[] = [doc];
  for (const k of path.slice(0, -1)) {
    const next = chain.at(-1)![k];
    if (!isObj(next)) return false;
    chain.push(next);
  }
  const last = path.at(-1)!;
  if (!Object.hasOwn(chain.at(-1)!, last)) return false;
  delete chain.at(-1)![last];
  for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]!).length; i--) {
    delete chain[i - 1]![path[i - 1]!];
  }
  return true;
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Removal {
  next: string | null; // null: delete the file
  detail: string;
}

// merge-json: drop the server entry, or rig's entries from every list rig
// writes (an older install may have filed an entry under another list).
const removeFromJson = (text: string, role: string, template: unknown): Removal | null => {
  const doc = JSON.parse(text) as unknown;
  if (!isObj(doc)) return null;
  let detail: string;
  if (role === 'hooks') {
    if (!isObj(doc.hooks)) return null;
    const { hooks, removed } = stripRigHooks(doc.hooks);
    if (!removed) return null;
    if (Object.keys(hooks).length) doc.hooks = hooks;
    else delete doc.hooks;
    detail = plural(removed, 'rig hook');
  } else if (role === 'permissions') {
    let count = 0;
    for (const [path, current] of listsUnder(doc, template)) {
      const kept = current.filter((e) => !isRigListEntry(e));
      count += current.length - kept.length;
      if (kept.length === current.length) continue;
      if (kept.length) {
        const parent = getAt(doc, path.slice(0, -1)) as Json;
        parent[path.at(-1)!] = kept;
      } else deleteAt(doc, path);
    }
    if (!count) return null;
    detail = plural(count, 'rig entry', 'rig entries');
  } else {
    const removed = serverPaths(template).filter((p) => deleteAt(doc, p));
    if (!removed.length) return null;
    detail = removed.map((p) => p.join('.')).join(', ');
  }
  return { next: Object.keys(doc).length ? JSON.stringify(doc, null, 2) + '\n' : null, detail };
};

const jsoncDelete = (text: string, path: readonly string[]): string =>
  applyEdits(text, modify(text, [...path], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }));

// merge-jsonc: same as JSON, through jsonc-parser edits so comments survive.
const removeFromJsonc = (text: string, role: string, template: unknown): Removal | null => {
  const paths = role === 'permissions' ? ownedKeysUnder(parseJsonc(text), template) : serverPaths(template);
  let result = text;
  const removed: string[][] = [];
  for (const path of paths) {
    if (getAt(parseJsonc(result), path) === undefined) continue;
    result = jsoncDelete(result, path);
    removed.push(path);
    for (let i = path.length - 1; i > 0; i--) {
      const parent = getAt(parseJsonc(result), path.slice(0, i));
      if (!isObj(parent) || Object.keys(parent).length) break;
      result = jsoncDelete(result, path.slice(0, i));
    }
  }
  if (!removed.length) return null;
  const detail =
    role === 'permissions'
      ? plural(removed.length, 'rig entry', 'rig entries')
      : removed.map((p) => p.join('.')).join(', ');
  return { next: result.replace(/\s+/g, '') === '{}' ? null : result, detail };
};

// write-toml: the server table and every table under it, or rig's keys in
// its per-tool tables (a table left without keys goes too).
const removeFromToml = (text: string, role: string, template: unknown): Removal | null => {
  const tables = isObj(template) ? flattenTables(template) : [];
  let result = text;
  let count = 0;
  if (role === 'permissions') {
    // rig's keys (approval_mode) in every rig tool table, listed or stale.
    const keys = [...new Set(tables.flatMap((t) => Object.keys(t.body)))];
    for (const header of listTomlTables(text).filter(isRigToolTable)) {
      const r = removeTomlKeys(result, header, keys);
      if (r.action === 'removed') {
        result = r.content;
        count++;
      }
    }
  } else {
    for (const { header } of tables) {
      const r = removeTomlTableTree(result, header);
      if (r.action === 'removed') {
        result = r.content;
        count++;
      }
    }
  }
  if (!count) return null;
  const detail =
    role === 'permissions'
      ? `approval_mode for ${plural(count, 'rig tool')}`
      : tables.map((t) => `[${t.header}] and its sub-tables`).join(', ');
  return { next: result.trim() ? result : null, detail };
};

const removeFromFile = (text: string, file: TargetFileLike, template: unknown): Removal | null => {
  switch (file.mode) {
    case 'merge-json':
      return removeFromJson(text, file.role, template);
    case 'merge-jsonc':
      return removeFromJsonc(text, file.role, template);
    case 'write-toml':
      return removeFromToml(text, file.role, template);
    case 'append-section': {
      const next = removeSection(text);
      if (next === text) return null;
      return { next: next.trim() ? next : null, detail: 'rig section' };
    }
    case 'replace':
      // The whole file is rig's — if it still carries rig's generated header.
      return text.includes(RIG_GENERATED_MARK) ? { next: null, detail: 'rig-generated file' } : null;
    default:
      return null;
  }
};

// Remove now-empty directories between a deleted file and the project root.
const pruneEmptyDirs = (from: string, root: string): void => {
  let dir = dirname(from);
  while (dir.startsWith(root + sep) && existsSync(dir) && !readdirSync(dir).length) {
    rmdirSync(dir);
    dir = dirname(dir);
  }
};

// Where a target's MCP config has rig's server entry: one { scope, path } per
// file that has it (used by `rig doctor`).
export const wiredLocations = (
  contract: TargetFiles,
  projectRoot: string,
  home?: string,
): Array<{ scope: Scope; path: string }> => {
  const out: Array<{ scope: Scope; path: string }> = [];
  for (const scope of ['project', 'global'] as const) {
    for (const file of filesInScope(contract, scope).filter((f) => f.role === 'mcp_config')) {
      const path = expandRelativeTo(file.path, resolve(projectRoot), home);
      if (!existsSync(path)) continue;
      try {
        const text = readFileSync(path, 'utf-8');
        const wired =
          file.mode === 'write-toml'
            ? isObj(file.template) &&
              flattenTables(file.template).some((t) => listTomlTables(text).includes(t.header))
            : serverPaths(file.template).some((p) =>
                isObj(getAt(file.mode === 'merge-jsonc' ? parseJsonc(text) : JSON.parse(text), p)),
              );
        if (wired) out.push({ scope, path });
      } catch {
        // unreadable config: not wired as far as we can tell
      }
    }
  }
  return out;
};

export async function uninstallTarget(
  contract: TargetFiles,
  opts: UninstallOptions,
): Promise<UninstallResult> {
  const scope = opts.scope ?? 'project';
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const removed: RemoveResult[] = [];
  // Reverse install order: instructions, then permissions, then the server.
  const files = filesInScope(contract, scope).filter(
    (f) => !opts.roles || opts.roles.includes(f.role),
  );
  for (const file of files.toReversed()) {
    const path = expandRelativeTo(file.path, projectRoot, opts.home);
    const base = { path, role: file.role, mode: file.mode };
    if (!existsSync(path)) {
      removed.push({ ...base, status: 'absent', detail: 'no such file' });
      continue;
    }
    let removal: Removal | null;
    try {
      const template = await expandTokens(file.template, opts);
      removal = removeFromFile(await readFile(path, 'utf-8'), file, template);
    } catch (e) {
      removed.push({ ...base, status: 'kept', detail: `left untouched: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!removal) {
      const detail = file.mode === 'replace' ? 'not rig-generated — left in place' : 'nothing of rig\'s in it';
      removed.push({ ...base, status: file.mode === 'replace' ? 'kept' : 'absent', detail });
      continue;
    }
    if (removal.next === null) {
      if (!opts.dryRun) {
        await rm(path, { force: true });
        if (scope === 'project') pruneEmptyDirs(path, projectRoot);
      }
      const why = file.mode === 'replace' ? '' : ' — nothing else was in it';
      removed.push({ ...base, status: 'deleted', detail: `${removal.detail}${why}` });
    } else {
      if (!opts.dryRun) await atomicWrite(path, removal.next);
      removed.push({ ...base, status: 'removed', detail: removal.detail });
    }
  }
  return { target: contract.name, scope, removed };
}
