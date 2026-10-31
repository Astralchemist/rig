// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import type { SqliteAdapter } from './adapter.ts';
import { distributionKeysOf, importKeysOf } from './pypi-names.ts';

// Package URLs (https://github.com/package-url/purl-spec) for declared
// dependencies, and `imports_package` edges from the files that import them.

const enc = (s: string): string => encodeURIComponent(s);

// npm: `pkg:npm/%40scope/name@1.2.3` (the scope is the namespace, its `@`
// percent-encoded). pypi: lowercase, `_` → `-`, per the purl pypi type.
export const purlOf = (
  source: string,
  name: string,
  version?: string | null,
  spec = '',
): string | null => {
  // Workspace, path and git dependencies aren't registry packages.
  if (/^(workspace|file|link|portal|git(\+[a-z]+)?|github):/.test(spec)) return null;
  const v = version ? `@${enc(version)}` : '';
  if (source === 'npm') {
    const m = /^(@[^/]+)\/(.+)$/.exec(name);
    return m ? `pkg:npm/${enc(m[1]!)}/${enc(m[2]!)}${v}` : `pkg:npm/${enc(name)}${v}`;
  }
  if (source === 'pypi') return `pkg:pypi/${enc(name.toLowerCase().replace(/_/g, '-'))}${v}`;
  return null;
};

// The exact version a spec pins, if it pins one: npm `1.2.3` or `=1.2.3`,
// pip `==1.2.3`. Ranges name no single version.
export const pinnedVersion = (source: string, spec: string): string | null => {
  const s = spec.trim();
  if (source === 'npm') {
    const m = /^=?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/.exec(s);
    return m ? m[1]! : null;
  }
  if (source === 'pypi') {
    const m = /^===?\s*([0-9][0-9A-Za-z.+!-]*)$/.exec(s);
    return m ? m[1]! : null;
  }
  return null;
};

// The package a bare import names: 'lodash/get' → 'lodash', '@a/b/c' → '@a/b';
// from Python, 'pandas.io' → 'pandas'. Relative, absolute, URL and `node:`
// imports name no package.
export const packageOfImport = (target: string, filePath: string): string | null => {
  if (!target || target.startsWith('.') || target.startsWith('/')) return null;
  if (filePath.endsWith('.py')) return target.split('.')[0] || null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // node:, bun:, https:, npm:
  if (target.startsWith('@')) {
    const parts = target.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return target.split('/')[0] || null;
};

interface Declared {
  id: string;
  dir: string;
}

const dirOf = (p: string): string => {
  const d = posix.dirname(p);
  return d === '.' ? '' : d;
};
const isUnder = (file: string, dir: string): boolean => dir === '' || file.startsWith(`${dir}/`);

/**
 * Rebuild every `imports_package` edge: importing node → the declared
 * dependency it names, taken from the nearest manifest above the importing
 * file that declares it (a workspace package's own manifest wins over the
 * root's). An import no manifest above declares gets no edge. Provenance is
 * `heuristic`: the match is by package name. Returns the edge count.
 */
export const rebuildDependencyEdges = (db: SqliteAdapter): number => {
  const deps = db
    .prepare(
      `SELECT id, name, json_extract(data, '$.depSource') AS source,
              json_extract(data, '$.filePath') AS manifest
       FROM nodes WHERE type = 'declared-dependency'`,
    )
    .all() as { id: string; name: string; source: string | null; manifest: string | null }[];
  const npm = new Map<string, Declared[]>();
  const pypi = new Map<string, Declared[]>();
  const add = (m: Map<string, Declared[]>, key: string, d: Declared): void => {
    const list = m.get(key);
    if (list) list.push(d);
    else m.set(key, [d]);
  };
  for (const d of deps) {
    const decl = { id: d.id, dir: dirOf(d.manifest ?? '') };
    if (d.source === 'npm') add(npm, d.name, decl);
    else if (d.source === 'pypi') for (const k of distributionKeysOf(d.name)) add(pypi, k, decl);
  }
  const nearest = (list: Declared[] | undefined, file: string): string | null => {
    let best: Declared | null = null;
    for (const d of list ?? [])
      if (isUnder(file, d.dir) && (!best || d.dir.length > best.dir.length)) best = d;
    return best?.id ?? null;
  };

  const refs = db
    .prepare(
      `SELECT DISTINCT src, target_name, file_path FROM unresolved_refs WHERE kind = 'imports'`,
    )
    .all() as { src: string; target_name: string; file_path: string }[];
  const del = db.prepare(`DELETE FROM edges WHERE kind = 'imports_package'`);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at)
     VALUES (?, ?, 'imports_package', 'heuristic', ?)`,
  );
  let n = 0;
  const now = Date.now();
  db.transaction(() => {
    del.run();
    for (const r of refs) {
      let dst: string | null = null;
      if (r.file_path.endsWith('.py')) {
        for (const k of importKeysOf(r.target_name)) {
          dst = nearest(pypi.get(k), r.file_path);
          if (dst) break;
        }
      } else {
        const pkg = packageOfImport(r.target_name, r.file_path);
        if (pkg) dst = nearest(npm.get(pkg), r.file_path);
      }
      if (dst && ins.run(r.src, dst, now).changes) n++;
    }
  })();
  return n;
};
