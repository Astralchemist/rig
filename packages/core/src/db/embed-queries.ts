import type { SqliteAdapter } from './adapter.ts';

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const fromBlob = (b: Buffer, dim: number): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + dim * 4));

export const upsertEmbedding = (
  db: SqliteAdapter,
  nodeId: string,
  model: string,
  vector: Float32Array,
  textHash = '',
): void => {
  db.prepare(
    `INSERT INTO embeddings (node_id, model, dim, vector, text_hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vector=excluded.vector, text_hash=excluded.text_hash`,
  ).run(nodeId, model, vector.length, toBlob(vector), textHash);
};

// Used by embedAndStore to skip re-embedding nodes whose embedding text hasn't
// changed since last index.
export const getEmbeddingFingerprint = (
  db: SqliteAdapter,
  nodeId: string,
): { model: string; text_hash: string } | null => {
  return db
    .prepare(`SELECT model, text_hash FROM embeddings WHERE node_id = ?`)
    .get(nodeId) as { model: string; text_hash: string } | null;
};

export const getEmbedding = (db: SqliteAdapter, nodeId: string): Float32Array | null => {
  const row = db
    .prepare('SELECT dim, vector FROM embeddings WHERE node_id = ?')
    .get(nodeId) as { dim: number; vector: Buffer } | null;
  return row ? fromBlob(row.vector, row.dim) : null;
};

// Batch variant — one SQL roundtrip instead of N. At 4.5k nodes this drops
// magnetic-pull's embedding-fetch cost from ~144ms to ~25ms. Chunked to stay
// under SQLite's 32766-parameter ceiling.
export const getEmbeddingsMap = (
  db: SqliteAdapter,
  ids: readonly string[],
): Map<string, Float32Array> => {
  const out = new Map<string, Float32Array>();
  if (ids.length === 0) return out;
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT node_id, dim, vector FROM embeddings WHERE node_id IN (${placeholders})`)
      .all(...slice) as { node_id: string; dim: number; vector: Buffer }[];
    for (const r of rows) out.set(r.node_id, fromBlob(r.vector, r.dim));
  }
  return out;
};
