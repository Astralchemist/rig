// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
/**
 * Tiny TOML helpers — just enough to inject / replace / remove a
 * single dotted-key table block (`[mcp_servers.rig]`) inside an
 * existing `~/.codex/config.toml`. We deliberately do NOT try to be a
 * general TOML parser/serializer; that would mean pulling in a
 * dependency (~50KB) for ~6 lines of output.
 *
 * Strategy: treat the file as text. Find the `[mcp_servers.rig]`
 * header line, splice it (and the lines that follow it until the next
 * `[...]` header or EOF) in or out. Everything outside that block is
 * preserved verbatim, byte-for-byte.
 *
 * Limitations (acceptable for our narrow use):
 *   - Only handles top-level table headers; not array-of-tables or
 *     subtables nested inside `[mcp_servers]` itself (we always write
 *     the full dotted key `[mcp_servers.rig]`).
 *   - Doesn't validate sibling TOML — if the file is malformed
 *     elsewhere, our injection won't fix it but won't make it worse.
 *   - Quotes string values with double quotes; escapes `\` and `"`.
 */

export function serializeTomlTableBody(values: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${quoteString(value)}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const parts = value.map(quoteString).join(', ');
      lines.push(`${key} = [${parts}]`);
    } else {
      throw new Error(`Unsupported TOML value type for key "${key}"`);
    }
  }
  return lines.join('\n');
}

function quoteString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function buildTomlTable(
  header: string,
  values: Record<string, string | string[]>,
): string {
  return `[${header}]\n${serializeTomlTableBody(values)}`;
}

export function upsertTomlTable(
  fileContent: string,
  header: string,
  block: string,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);

  if (headerIdx === -1) {
    const trimmed = fileContent.trimEnd();
    const sep = trimmed.length > 0 ? '\n\n' : '';
    return { content: trimmed + sep + block + '\n', action: 'inserted' };
  }

  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const existingBlock = fileContent.substring(headerIdx, blockEnd).replace(/\n+$/, '');

  if (existingBlock === block) {
    return { content: fileContent, action: 'unchanged' };
  }

  const before = fileContent.substring(0, headerIdx);
  const after = fileContent.substring(blockEnd);
  const beforeClean = before.replace(/\n+$/, '');
  const afterClean = after.replace(/^\n+/, '');
  const sepBefore = beforeClean.length > 0 ? '\n\n' : '';
  const sepAfter = afterClean.length > 0 ? '\n\n' : '\n';
  return {
    content: beforeClean + sepBefore + block + sepAfter + afterClean,
    action: 'replaced',
  };
}

export function removeTomlTable(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);
  if (headerIdx === -1) return { content: fileContent, action: 'not-found' };

  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const before = fileContent.substring(0, headerIdx).replace(/\n+$/, '');
  const after = fileContent.substring(blockEnd).replace(/^\n+/, '');
  const joined = before + (before && after ? '\n\n' : '') + after;
  return { content: joined && !joined.endsWith('\n') ? `${joined}\n` : joined, action: 'removed' };
}

function findHeaderIndex(content: string, headerLine: string): number {
  if (content.startsWith(headerLine)) return 0;
  const needle = '\n' + headerLine;
  const idx = content.indexOf(needle);
  return idx === -1 ? -1 : idx + 1;
}

// Any line that starts with `[` opens the next table — `[table]` and
// `[[array.of.tables]]` alike — so a block never swallows the user's
// array-of-tables that happens to follow it.
function findNextTableHeader(content: string, from: number): number {
  const nlIdx = content.indexOf('\n[', from);
  return nlIdx === -1 ? content.length : nlIdx + 1;
}

export interface TomlTable {
  header: string;
  body: Record<string, string | string[]>;
}

const isPrimitive = (v: unknown): v is string | string[] =>
  typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/**
 * Walk a template down to every table that holds primitive values:
 * `{ mcp_servers: { rig: { command: '…', tools: { a: { approval_mode: 'approve' } } } } }`
 * → `[mcp_servers.rig]` (command) and `[mcp_servers.rig.tools.a]` (approval_mode).
 */
export function flattenTables(obj: Record<string, unknown>, prefix: string[] = []): TomlTable[] {
  const body: Record<string, string | string[]> = {};
  const nested: TomlTable[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isPrimitive(v)) body[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      nested.push(...flattenTables(v as Record<string, unknown>, [...prefix, k]));
    } else throw new Error(`Unsupported TOML value type for key "${k}"`);
  }
  if (Object.keys(body).length && !prefix.length) {
    throw new Error('write-toml template values must sit inside a table');
  }
  const own = Object.keys(body).length ? [{ header: prefix.join('.'), body }] : [];
  return [...own, ...nested];
}

// The bare or quoted key a `key = value` line assigns, else null.
const keyOfLine = (line: string): string | null => {
  const m = /^\s*([A-Za-z0-9_-]+|"[^"]*")\s*=/.exec(line);
  return m ? m[1]!.replace(/^"|"$/g, '') : null;
};

// Every `[table]` header in the file, in order (array-of-tables excluded).
export const listTomlTables = (fileContent: string): string[] =>
  [...fileContent.matchAll(/^\[([^[\]\n]+)\][ \t]*$/gm)].map((m) => m[1]!.trim());

/**
 * Set individual keys inside `[header]` and leave the table's other keys,
 * comments and order alone; appends the table when it's missing. Values are
 * written on one line, so only use it for keys with single-line values.
 */
export function upsertTomlKeys(
  fileContent: string,
  header: string,
  values: Record<string, string | string[]>,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);
  if (headerIdx === -1) return upsertTomlTable(fileContent, header, buildTomlTable(header, values));

  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const lines = fileContent.substring(headerIdx, blockEnd).split('\n');
  let insertAt = 1;
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    const line = serializeTomlTableBody({ [key]: value });
    const i = lines.findIndex((l, n) => n > 0 && keyOfLine(l) === key);
    if (i === -1) {
      lines.splice(insertAt++, 0, line);
      changed = true;
    } else if (lines[i] !== line) {
      lines[i] = line;
      changed = true;
    }
  }
  if (!changed) return { content: fileContent, action: 'unchanged' };
  return {
    content: fileContent.substring(0, headerIdx) + lines.join('\n') + fileContent.substring(blockEnd),
    action: 'replaced',
  };
}

/**
 * Remove keys from `[header]`; drops the whole table once no key is left in
 * it. Everything else in the file is untouched.
 */
export function removeTomlKeys(
  fileContent: string,
  header: string,
  keys: readonly string[],
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);
  if (headerIdx === -1) return { content: fileContent, action: 'not-found' };
  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const lines = fileContent.substring(headerIdx, blockEnd).split('\n');
  const kept = lines.filter((l, n) => n === 0 || !keys.includes(keyOfLine(l) ?? ''));
  if (kept.length === lines.length) return { content: fileContent, action: 'not-found' };
  if (!kept.slice(1).some((l) => keyOfLine(l) !== null)) return removeTomlTable(fileContent, header);
  return {
    content: fileContent.substring(0, headerIdx) + kept.join('\n') + fileContent.substring(blockEnd),
    action: 'removed',
  };
}

/**
 * Remove `[header]` and every table nested under it (`[header.…]`) — e.g. a
 * server entry together with its per-tool and env sub-tables.
 */
export function removeTomlTableTree(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const names = listTomlTables(fileContent).filter(
    (name) => name === header || name.startsWith(`${header}.`),
  );
  let content = fileContent;
  for (const name of names) content = removeTomlTable(content, name).content;
  return names.length ? { content, action: 'removed' } : { content: fileContent, action: 'not-found' };
}
