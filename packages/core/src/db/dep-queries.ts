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
