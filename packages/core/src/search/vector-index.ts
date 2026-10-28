// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from '../db/adapter.ts';

// Cosine below this is no match. Unrelated texts sit near 0 for hash-style
// embedders; bge-small rarely goes under ~0.35 even for unrelated code, so
// for it this cuts only true noise and ranking does the rest.
export const VECTOR_MIN_SIMILARITY = 0.35;

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorSearchOptions {
  k: number;
  kinds?: readonly string[] | undefined;
  sourceOnly?: boolean | undefined;
  minScore?: number;
}

interface Row {
  node_id: string;
  dim: number;
  vector: Uint8Array;
  seq: number;
  type: string;
  has_file: number;
}

// Every vector of one model in one Float32Array (row-major, L2-normalized,
// so a dot product is the cosine), scored by brute force: 20k × 384 floats is
// a few milliseconds. Loaded once; refresh() then reads only the rows written
// since (embeddings.seq, v14) and reloads in full only when rows disappeared.
export class VectorIndex {
  private dim = 0;
  private count = 0;
  private matrix = new Float32Array(0);
  private ids: string[] = [];
  private kinds: string[] = [];
  private hasFile: boolean[] = [];
  private rowOf = new Map<string, number>();
  // Rows of the table left out as corrupt, so the row-count check still adds up.
  private skipped = 0;
  // Highest seq loaded; -1 until the first load.
  private seq = -1;

  constructor(
    private readonly db: SqliteAdapter,
    readonly model: string,
  ) {}

  get size(): number {
    return this.count;
  }

  get loaded(): boolean {
    return this.seq >= 0;
  }

  // Bring the index up to date with the embeddings table: the full load the
  // first time, then rows with a newer seq. When the table holds a different
  // number of rows than the index afterwards, something was deleted (a node
  // removed, a model switched) and the index is rebuilt.
  refresh(): void {
    if (this.seq < 0) {
      this.reload();
      return;
    }
    const rows = this.db
      .prepare(`${SELECT} WHERE e.model = ? AND e.seq > ? ORDER BY e.seq`)
      .all(this.model, this.seq) as Row[];
    for (const r of rows) this.upsert(r);
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE model = ?`)
      .get(this.model) as { n: number };
    if (n !== this.count + this.skipped) this.reload();
  }

  private reload(): void {
    this.count = 0;
    this.ids = [];
    this.kinds = [];
    this.hasFile = [];
    this.rowOf.clear();
    this.skipped = 0;
    this.seq = 0;
    const rows = this.db.prepare(`${SELECT} WHERE e.model = ?`).all(this.model) as Row[];
    this.dim = rows[0]?.dim ?? 0;
    this.matrix = new Float32Array(rows.length * this.dim);
    for (const r of rows) this.upsert(r);
  }

  private upsert(r: Row): void {
    if (r.seq > this.seq) this.seq = r.seq;
    if (this.dim === 0) this.dim = r.dim;
    // One model, one dimension; a row that disagrees is corrupt — skip it.
    if (r.dim !== this.dim || r.vector.byteLength < r.dim * 4) {
      if (!this.rowOf.has(r.node_id)) this.skipped++;
      return;
    }
    let row = this.rowOf.get(r.node_id);
    if (row === undefined) {
      row = this.count++;
      this.rowOf.set(r.node_id, row);
      this.ensureCapacity(this.count);
    }
    this.ids[row] = r.node_id;
    this.kinds[row] = r.type;
    this.hasFile[row] = r.has_file === 1;
    // Copy out of the blob (its buffer may be shared and unaligned), then
    // normalize so stored vectors and queries compare by dot product.
    const v = new Float32Array(
      r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.dim * 4),
    );
    const at = row * this.dim;
    this.matrix.set(normalize(v), at);
  }

  private ensureCapacity(rows: number): void {
    if (this.matrix.length >= rows * this.dim) return;
    const next = new Float32Array(
      Math.max(rows, Math.ceil(this.matrix.length / this.dim) * 2, 64) * this.dim,
    );
    next.set(this.matrix);
    this.matrix = next;
  }

  // The k nearest rows to `query` with cosine ≥ minScore, best first.
  search(query: Float32Array, opts: VectorSearchOptions): VectorHit[] {
    const dim = this.dim;
    if (this.count === 0 || query.length !== dim) return [];
    const q = normalize(Float32Array.from(query));
    const min = opts.minScore ?? VECTOR_MIN_SIMILARITY;
    const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
    const k = Math.max(1, opts.k);
    // Kept sorted descending; a candidate must beat the current k-th best.
    const top: { row: number; score: number }[] = [];
    let floor = min;
    const m = this.matrix;
    for (let row = 0; row < this.count; row++) {
      if (kinds && !kinds.has(this.kinds[row]!)) continue;
      if (opts.sourceOnly && !this.hasFile[row]) continue;
      const s = dot(m, row * dim, q, dim);
      if (s < floor) continue;
      let at = top.length;
      while (at > 0 && top[at - 1]!.score < s) at--;
      top.splice(at, 0, { row, score: s });
      if (top.length > k) top.pop();
      if (top.length === k) floor = Math.max(min, top[k - 1]!.score);
    }
    return top.map((t) => ({ id: this.ids[t.row]!, score: t.score }));
  }
}

const SELECT = `SELECT e.node_id, e.dim, e.vector, e.seq, n.type,
    COALESCE(json_extract(n.data, '$.filePath'), '') != '' AS has_file
  FROM embeddings e JOIN nodes n ON n.id = e.node_id`;

// Unrolled by four (embedding dims are multiples of it; the tail loop covers
// any that aren't): ~4x the plain loop at 384 dims (20k rows: 16ms → 4ms).
const dot = (m: Float32Array, base: number, q: Float32Array, dim: number): number => {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let i = 0;
  for (; i + 3 < dim; i += 4) {
    s0 += m[base + i]! * q[i]!;
    s1 += m[base + i + 1]! * q[i + 1]!;
    s2 += m[base + i + 2]! * q[i + 2]!;
    s3 += m[base + i + 3]! * q[i + 3]!;
  }
  for (; i < dim; i++) s0 += m[base + i]! * q[i]!;
  return s0 + s1 + s2 + s3;
};

const normalize = (v: Float32Array): Float32Array => {
  let sumsq = 0;
  for (let i = 0; i < v.length; i++) sumsq += v[i]! * v[i]!;
  if (sumsq === 0) return v;
  const inv = 1 / Math.sqrt(sumsq);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
};
