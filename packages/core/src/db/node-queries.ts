// SPDX-License-Identifier: Apache-2.0
import type { Node } from '../extract/upstream-types.ts';
import type { SqliteAdapter } from './adapter.ts';

const NODE_DATA_KEYS = [
  'qualifiedName',
  'filePath',
  'language',
  'startLine',
  'endLine',
  'startColumn',
  'endColumn',
  'docstring',
  'signature',
  'visibility',
  'isExported',
  'isAsync',
  'isStatic',
  'isAbstract',
  'decorators',
  'typeParameters',
  'depName',
  'depSpec',
  'depSource',
  'isDevDep',
  'isOptionalDep',
  'isPeerDep',
  'resolvedVersion',
] as const;

const pickData = (n: Node): Record<string, unknown> => {
  const src = n as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NODE_DATA_KEYS) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
};

export const upsertNode = (db: SqliteAdapter, n: Node): void => {
  const data = JSON.stringify(pickData(n));
  const now = Date.now();
  db.prepare(
    `INSERT INTO nodes (id, type, name, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at`,
  ).run(n.id, n.kind, n.name, data, now, now);
};

// Remove all nodes (and cascading edges/embeddings) for a file path. Call
// before re-extracting so position-keyed node IDs don't leave stale duplicates
// when content shifts. Used by sync (on file change) and index --force.
export const purgeFileNodes = (db: SqliteAdapter, filePath: string): void => {
  db.prepare(`DELETE FROM nodes WHERE json_extract(data, '$.filePath') = ?`).run(filePath);
};

export const upsertFile = (
  db: SqliteAdapter,
  path: string,
  mtime: number,
  hash: string,
): void => {
  db.prepare(
    `INSERT INTO files (path, mtime, hash)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, hash=excluded.hash`,
  ).run(path, mtime, hash);
};

// Batch is_hub lookup. One SQL roundtrip; used by D2's hub-aware pull bias.
// Chunked to stay under SQLite's 32766-parameter ceiling.
export const getHubFlags = (
  db: SqliteAdapter,
  ids: readonly string[],
): Set<string> => {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM nodes WHERE is_hub = 1 AND id IN (${placeholders})`)
      .all(...slice) as { id: string }[];
    for (const r of rows) out.add(r.id);
  }
  return out;
};
