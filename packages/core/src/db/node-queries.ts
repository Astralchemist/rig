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
  'excerpt',
] as const;

// The persisted `data` JSON of an extracted node: whitelisted fields only.
export const pickData = (n: Node): Record<string, unknown> => {
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

// `extractorVersion` records which EXTRACTOR_VERSION produced the file's rows
// and artifacts; NULL (pre-v12) means it has no artifacts yet.
export const upsertFile = (
  db: SqliteAdapter,
  path: string,
  mtime: number,
  hash: string,
  extractorVersion: number | null = null,
): void => {
  db.prepare(
    `INSERT INTO files (path, mtime, hash, extractor_version)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, hash=excluded.hash,
       extractor_version=excluded.extractor_version`,
  ).run(path, mtime, hash, extractorVersion);
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
