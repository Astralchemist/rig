import type { SqliteAdapter } from './adapter.ts';

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const fromBlob = (b: Buffer, dim: number): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + dim * 4));

export const upsertEmbedding = (
  db: SqliteAdapter,
  nodeId: string,
  model: string,
  vector: Float32Array,
): void => {
  db.prepare(
    `INSERT INTO embeddings (node_id, model, dim, vector) VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vector=excluded.vector`,
  ).run(nodeId, model, vector.length, toBlob(vector));
};

export const getEmbedding = (db: SqliteAdapter, nodeId: string): Float32Array | null => {
  const row = db
    .prepare('SELECT dim, vector FROM embeddings WHERE node_id = ?')
    .get(nodeId) as { dim: number; vector: Buffer } | null;
  return row ? fromBlob(row.vector, row.dim) : null;
};
