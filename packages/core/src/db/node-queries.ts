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
