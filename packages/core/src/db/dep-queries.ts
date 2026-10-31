// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';
import { nonImportUse, usageContext } from './dep-usage.ts';
import { distributionKeysOf, importKeysOf, normalizePypiName } from './pypi-names.ts';
import { PYTHON_STDLIB } from './python-stdlib.ts';

export interface DepRow {
  id: string;
  name: string;
  spec: string;
  source: string;
  manifest_path: string;
  is_dev: boolean;
  is_optional: boolean;
  is_peer: boolean;
  resolved_version: string | null;
  /** Package URL (purl), versioned when one version is known. */
  purl: string | null;
  /** Files and symbols that import it (`imports_package` edges). */
  used_by: number;
}

interface NodeRow {
  id: string;
  name: string;
  data: string;
}

interface DepData {
  depSpec?: string;
  depSource?: string;
  filePath?: string;
  isDevDep?: boolean;
  isOptionalDep?: boolean;
  isPeerDep?: boolean;
  resolvedVersion?: string;
  purl?: string;
}

export interface DepConflictRow {
  name: string;
  source: string;
  manifests: Array<{ manifest_path: string; spec: string; is_dev: boolean }>;
}

interface ConflictRaw {
  name: string;
  source: string;
  data: string;
}

// Find dependency names declared with two or more distinct version specs
// across manifests. Cross-ecosystem (different `source` values) does not
// count as a conflict — pypi:pandas and npm:pandas would be unrelated even
// with the same name. The aggregation runs in JS so we can decode each
// declaration's manifest_path from the JSON `data` column.
export const listDependencyConflicts = (db: SqliteAdapter): DepConflictRow[] => {
  const rows = db
    .prepare(
      `SELECT name, json_extract(data, '$.depSource') AS source, data
       FROM nodes
       WHERE type = 'declared-dependency'
       ORDER BY name ASC, json_extract(data, '$.filePath') ASC`,
    )
    .all() as ConflictRaw[];

  const grouped = new Map<string, DepConflictRow>();
  for (const r of rows) {
    const key = `${r.source}::${r.name}`;
    const d = JSON.parse(r.data) as {
      depSpec?: string;
      filePath?: string;
      isDevDep?: boolean;
    };
    const entry = grouped.get(key) ?? {
      name: r.name,
      source: r.source ?? 'unknown',
      manifests: [],
    };
    entry.manifests.push({
      manifest_path: d.filePath ?? '',
      spec: d.depSpec ?? '',
      is_dev: d.isDevDep === true,
    });
    grouped.set(key, entry);
  }

  const out: DepConflictRow[] = [];
  for (const entry of grouped.values()) {
    const distinct = new Set(entry.manifests.map((m) => m.spec));
    if (distinct.size >= 2) out.push(entry);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

export interface UnusedDepRow {
  id: string;
  name: string;
  spec: string;
  source: string;
  manifest_path: string;
  is_dev: boolean;
}

// Python import targets are dotted module paths, and the package is the
// top-level module: 'pandas.io.sql' → 'pandas'. Relative targets ('.models')
// name no package.
const pythonPackageOf = (target: string): string | null =>
  target.startsWith('.') ? null : (target.split('.')[0] ?? null);

// Heuristic: a declared dep is "unused" when its name (or scoped prefix) never
// appears as a target_name in unresolved_refs — that's where bare-specifier
// imports land after the resolver fails to map them to a file. Handles scoped
// packages (@types/node), subpath imports (lodash/get), dotted Python modules
// (pandas.io) and PyPI names that differ from the module (PyYAML → yaml).
// Given the project root, uses that aren't imports also count (dep-usage.ts):
// commands in scripts and CI, config files, @types pairs, workspace packages
// and peers. Still "likely unused, verify before removing", not authoritative.
export const listUnusedDependencies = (
  db: SqliteAdapter,
  projectRoot?: string,
): UnusedDepRow[] => {
  const targetRows = db
    .prepare(`SELECT DISTINCT target_name FROM unresolved_refs`)
    .all() as { target_name: string }[];
  const used = new Set<string>();
  for (const r of targetRows) {
    const t = r.target_name;
    used.add(t);
    // 'pandas/io' → 'pandas'; '@types/node/path' → '@types/node'
    if (t.startsWith('@')) {
      const parts = t.split('/');
      if (parts.length >= 2) used.add(`${parts[0]}/${parts[1]}`);
    } else {
      const top = t.split('/')[0];
      if (top) used.add(top);
    }
  }
  // Python imports name modules, not distributions; PyPI deps match them by
  // import key below.
  const pythonImports = db
    .prepare(
      `SELECT DISTINCT target_name FROM unresolved_refs
       WHERE kind = 'imports' AND file_path LIKE '%.py'`,
    )
    .all() as { target_name: string }[];
  const pythonKeys = new Set(pythonImports.flatMap((r) => importKeysOf(r.target_name)));

  const declared = db
    .prepare(
      `SELECT id, name, data FROM nodes
       WHERE type = 'declared-dependency'
       ORDER BY name ASC`,
    )
    .all() as { id: string; name: string; data: string }[];

  const ctx = projectRoot ? usageContext(db, projectRoot) : null;
  const isImported = (pkg: string): boolean =>
    used.has(pkg) || pythonKeys.has(normalizePypiName(pkg));

  // What each manifest declares, for framework peers and @types pairs.
  const siblings = new Map<string, Set<string>>();
  for (const d of declared) {
    const m = (JSON.parse(d.data) as { filePath?: string }).filePath ?? '';
    const set = siblings.get(m) ?? new Set<string>();
    set.add(d.name);
    siblings.set(m, set);
  }

  const flagged: { d: (typeof declared)[number]; manifest: string }[] = [];
  const out: UnusedDepRow[] = [];
  for (const d of declared) {
    if (used.has(d.name)) continue;
    const parsed = JSON.parse(d.data) as {
      depSpec?: string;
      depSource?: string;
      filePath?: string;
      isDevDep?: boolean;
      isPeerDep?: boolean;
    };
    if (parsed.depSource === 'pypi' && distributionKeysOf(d.name).some((k) => pythonKeys.has(k))) {
      continue;
    }
    if (
      ctx &&
      projectRoot &&
      nonImportUse(
        ctx,
        projectRoot,
        {
          name: d.name,
          source: parsed.depSource ?? '',
          manifest: parsed.filePath ?? '',
          spec: parsed.depSpec ?? '',
          isPeer: parsed.isPeerDep === true,
        },
        isImported,
        siblings,
      )
    ) {
      continue;
    }
    flagged.push({ d, manifest: parsed.filePath ?? '' });
    out.push({
      id: d.id,
      name: d.name,
      spec: parsed.depSpec ?? '',
      source: parsed.depSource ?? 'unknown',
      manifest_path: parsed.filePath ?? '',
      is_dev: parsed.isDevDep === true,
    });
  }
  // @types/X is used when X is: drop it when its own manifest declares X and
  // X wasn't flagged (its use was found some other way than an import).
  if (ctx) {
    const flaggedKeys = new Set(flagged.map((f) => `${f.manifest}::${f.d.name}`));
    const keep = new Set(
      flagged
        .filter(({ d, manifest }) => {
          if (!d.name.startsWith('@types/')) return true;
          const x = d.name.slice(7);
          const target = x.includes('__') ? `@${x.replace('__', '/')}` : x;
          return !(siblings.get(manifest)?.has(target) && !flaggedKeys.has(`${manifest}::${target}`));
        })
        .map((f) => f.d.id),
    );
    return out.filter((r) => keep.has(r.id));
  }
  return out;
};

export interface PhantomImportRow {
  target_name: string;
  occurrences: number;
  sample_file: string;
  sample_line: number;
}

// The mirror of unused-deps: import sites whose target_name has no matching
// declared dependency. Often a missing-dependency bug or a typo. Scoped +
// subpath normalization mirrors listUnusedDependencies so the two views agree.
// Python standard-library modules need no declaration and are never phantoms;
// other Python imports match declared PyPI deps by import key (PyYAML → yaml).
export const listPhantomImports = (db: SqliteAdapter): PhantomImportRow[] => {
  const declared = db
    .prepare(
      `SELECT name, json_extract(data, '$.depSource') AS source
       FROM nodes WHERE type = 'declared-dependency'`,
    )
    .all() as { name: string; source: string | null }[];
  const declaredNames = new Set(declared.map((d) => d.name));
  const pypiKeys = new Set(
    declared.filter((d) => d.source === 'pypi').flatMap((d) => distributionKeysOf(d.name)),
  );

  const rows = db
    .prepare(
      `SELECT target_name, COUNT(*) AS occurrences,
              MIN(file_path) AS sample_file, MIN(line) AS sample_line
       FROM unresolved_refs
       WHERE kind = 'imports'
       GROUP BY target_name
       ORDER BY occurrences DESC, target_name ASC`,
    )
    .all() as {
    target_name: string;
    occurrences: number;
    sample_file: string;
    sample_line: number;
  }[];

  // Normalize subpath / scoped imports the same way listUnusedDependencies does
  // — '@types/node/path' resolves to '@types/node', 'lodash/get' to 'lodash',
  // and from Python files 'pandas.io' to 'pandas'.
  const normalize = (t: string, filePath: string): string => {
    const py = filePath.endsWith('.py') ? pythonPackageOf(t) : null;
    if (py) return py;
    if (t.startsWith('@')) {
      const parts = t.split('/');
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : t;
    }
    return t.split('/')[0] ?? t;
  };

  return rows.filter((r) => {
    const pkg = normalize(r.target_name, r.sample_file);
    // Relative + absolute imports never resolve to a declared dep; they're
    // file-resolution failures, not phantoms.
    if (pkg.startsWith('.') || pkg.startsWith('/')) return false;
    if (r.sample_file.endsWith('.py')) {
      if (PYTHON_STDLIB.has(pkg)) return false;
      return !importKeysOf(r.target_name).some((k) => pypiKeys.has(k));
    }
    return !declaredNames.has(pkg);
  });
};

export const listDependencies = (
  db: SqliteAdapter,
  manifestPath?: string,
): DepRow[] => {
  const rows = manifestPath
    ? (db
        .prepare(
          `SELECT id, name, data FROM nodes
           WHERE type = 'declared-dependency'
             AND json_extract(data, '$.filePath') = ?
           ORDER BY name ASC`,
        )
        .all(manifestPath) as NodeRow[])
    : (db
        .prepare(
          `SELECT id, name, data FROM nodes
           WHERE type = 'declared-dependency'
           ORDER BY name ASC`,
        )
        .all() as NodeRow[]);
  const usedBy = db.prepare(
    `SELECT COUNT(DISTINCT src) AS n FROM edges WHERE dst = ? AND kind = 'imports_package'`,
  );
  return rows.map((r) => {
    const d = JSON.parse(r.data) as DepData;
    return {
      id: r.id,
      name: r.name,
      spec: d.depSpec ?? '',
      source: d.depSource ?? 'unknown',
      manifest_path: d.filePath ?? '',
      is_dev: d.isDevDep === true,
      is_optional: d.isOptionalDep === true,
      is_peer: d.isPeerDep === true,
      resolved_version: d.resolvedVersion ?? null,
      purl: d.purl ?? null,
      used_by: (usedBy.get(r.id) as { n: number }).n,
    };
  });
};
