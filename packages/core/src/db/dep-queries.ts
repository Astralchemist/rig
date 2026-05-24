import type { SqliteAdapter } from './adapter.ts';

export interface DepRow {
  id: string;
  name: string;
  spec: string;
  source: string;
  manifest_path: string;
  is_dev: boolean;
  is_optional: boolean;
  is_peer: boolean;
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
    };
  });
};
