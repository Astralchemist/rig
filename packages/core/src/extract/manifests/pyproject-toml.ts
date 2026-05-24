import { createHash } from 'node:crypto';
import { fileIdOf, makeFileNode } from '../node-builders.ts';
import type { Edge, ExtractionResult, Node } from '../upstream-types.ts';

// Narrow TOML reader scoped to the dep-declaration tables we care about. Not
// a full PEP 508 / TOML parser — covers the common PEP 621 + Poetry shapes:
//   [project] dependencies = ["foo>=1.0", "bar~=2"]
//   [project.optional-dependencies] dev = ["pytest"]
//   [tool.poetry.dependencies] foo = "*" / foo = { version = "1.0" }

const depIdOf = (manifestPath: string, name: string, suffix: string): string => {
  const hash = createHash('sha256')
    .update(`${manifestPath}::${suffix}::dep::${name}`)
    .digest('hex')
    .slice(0, 32);
  return `dep:${hash}`;
};

const splitTables = (source: string): Map<string, string> => {
  const out = new Map<string, string>();
  const lines = source.split('\n');
  let current = '';
  let buf: string[] = [];
  const flush = (): void => {
    if (current) out.set(current, buf.join('\n'));
  };
  for (const line of lines) {
    const stripped = line.replace(/^\s*#.*$/, '').trimEnd();
    const m = stripped.match(/^\s*\[([a-zA-Z0-9_.\-]+)\]\s*$/);
    if (m) {
      flush();
      current = m[1]!;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
};

const parseArrayItems = (body: string, key: string): string[] => {
  const re = new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const m = body.match(re);
  if (!m) return [];
  // Match double- or single-quoted string contents, allowing whitespace
  // between commas. Strips the wrapping quotes from each match.
  return Array.from(m[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)).map(
    (mm) => (mm[1] ?? mm[2] ?? '').trim(),
  );
};

// Split "pandas>=2.0,<3" → { name: 'pandas', spec: '>=2.0,<3' }. PEP 508 allows
// markers (`; python_version<"3.11"`) and extras (`pandas[arrow]`); we treat
// the spec as everything after the name and pre-marker chunk.
const parsePep508 = (raw: string): { name: string; spec: string } | null => {
  const beforeMarker = raw.split(';')[0]!.trim();
  if (!beforeMarker) return null;
  const m = beforeMarker.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  return { name: m[1]!, spec: m[3]!.trim() || '*' };
};

const poetryEntries = (body: string): Array<{ name: string; spec: string }> => {
  const out: Array<{ name: string; spec: string }> = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || !/^[A-Za-z]/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const name = m[1]!;
    if (name.toLowerCase() === 'python') continue;
    const value = m[2]!.trim();
    let spec = '*';
    if (value.startsWith('"') || value.startsWith("'")) {
      const q = value[0]!;
      const close = value.indexOf(q, 1);
      if (close > 0) spec = value.slice(1, close);
    } else if (value.startsWith('{')) {
      const vm = value.match(/version\s*=\s*"([^"]+)"/);
      if (vm) spec = vm[1]!;
    }
    out.push({ name, spec });
  }
  return out;
};

const makeDep = (
  manifestPath: string,
  name: string,
  spec: string,
  flags: { isDev?: boolean; isOptional?: boolean },
  suffix: string,
): Node => ({
  id: depIdOf(manifestPath, name, suffix),
  kind: 'declared-dependency',
  name,
  qualifiedName: spec === '*' ? `pypi:${name}` : `pypi:${name}${/^[!~<>=]/.test(spec) ? spec : '==' + spec}`,
  filePath: manifestPath,
  language: 'json',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 0,
  depName: name,
  depSpec: spec,
  depSource: 'pypi',
  isDevDep: flags.isDev === true,
  isOptionalDep: flags.isOptional === true,
  isPeerDep: false,
  updatedAt: Date.now(),
});

export const extractPyprojectToml = (
  filePath: string,
  source: string,
): Omit<ExtractionResult, 'durationMs'> => {
  const tables = splitTables(source);
  const fileId = fileIdOf(filePath);
  const nodes: Node[] = [makeFileNode(fileId, filePath, 'json')];
  const edges: Edge[] = [];

  const add = (name: string, spec: string, flags: { isDev?: boolean; isOptional?: boolean }, suffix: string): void => {
    if (!name) return;
    const dep = makeDep(filePath, name, spec, flags, suffix);
    nodes.push(dep);
    edges.push({ source: fileId, target: dep.id, kind: 'manifest_declares', provenance: 'heuristic' });
  };

  // PEP 621 runtime
  const projectBody = tables.get('project') ?? '';
  for (const item of parseArrayItems(projectBody, 'dependencies')) {
    const p = parsePep508(item);
    if (p) add(p.name, p.spec, {}, 'runtime');
  }

  // PEP 621 optional-deps (each key is an extras group)
  const optBody = tables.get('project.optional-dependencies') ?? '';
  const optKeyRe = /^\s*([A-Za-z0-9_-]+)\s*=\s*\[/gm;
  let km;
  while ((km = optKeyRe.exec(optBody)) !== null) {
    const key = km[1]!;
    const isDev = /^(dev|test|tests|lint)$/i.test(key);
    for (const item of parseArrayItems(optBody, key)) {
      const p = parsePep508(item);
      if (p) add(p.name, p.spec, { isDev, isOptional: !isDev }, `extra:${key}`);
    }
  }

  // Poetry runtime
  for (const e of poetryEntries(tables.get('tool.poetry.dependencies') ?? '')) {
    add(e.name, e.spec, {}, 'poetry-runtime');
  }
  // Poetry dev (legacy)
  for (const e of poetryEntries(tables.get('tool.poetry.dev-dependencies') ?? '')) {
    add(e.name, e.spec, { isDev: true }, 'poetry-dev');
  }

  return { nodes, edges, unresolvedReferences: [], errors: [] };
};
