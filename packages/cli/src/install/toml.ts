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
  return { content: joined, action: 'removed' };
}

function findHeaderIndex(content: string, headerLine: string): number {
  if (content.startsWith(headerLine)) return 0;
  const needle = '\n' + headerLine;
  const idx = content.indexOf(needle);
  return idx === -1 ? -1 : idx + 1;
}

function findNextTableHeader(content: string, from: number): number {
  let i = from;
  while (i < content.length) {
    const nlIdx = content.indexOf('\n[', i);
    if (nlIdx === -1) return content.length;
    if (content[nlIdx + 2] === '[') {
      i = nlIdx + 2;
      continue;
    }
    return nlIdx + 1;
  }
  return content.length;
}

/**
 * Walk a template like `{ mcp_servers: { rig: { command: '...', args: [...] } } }`
 * down to the leaf primitive object. Returns the dotted-key path and the leaf.
 */
export function flattenSingleTable(
  obj: Record<string, unknown>,
  prefix: string[] = [],
): { header: string; body: Record<string, string | string[]> } {
  const entries = Object.entries(obj);
  const isPrimitive = (v: unknown): v is string | string[] =>
    typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (entries.length > 0 && entries.every(([, v]) => isPrimitive(v))) {
    return { header: prefix.join('.'), body: obj as Record<string, string | string[]> };
  }
  for (const [k, v] of entries) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return flattenSingleTable(v as Record<string, unknown>, [...prefix, k]);
    }
  }
  throw new Error('write-toml template must contain a nested object of string|string[] primitives');
}
