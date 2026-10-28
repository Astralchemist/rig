// SPDX-License-Identifier: Apache-2.0
import type { Node } from '../extract/upstream-types.ts';
import {
  EXACT_LIST_CAP,
  EXACT_WEIGHT,
  fuseRrf,
  type MatchSource,
  type RankedList,
} from '../search/fuse.ts';
import { nameVariants, parseQuery, queryShape } from '../search/query.ts';
import type { SqliteAdapter } from './adapter.ts';

interface NodeRow {
  id: string;
  type: string;
  name: string;
  data: string;
}

const rowToNode = (row: NodeRow): Node => {
  const data = JSON.parse(row.data) as Partial<Node>;
  return {
    id: row.id,
    kind: row.type as Node['kind'],
    name: row.name,
    qualifiedName: data.qualifiedName ?? row.name,
    filePath: data.filePath ?? '',
    language: data.language ?? 'unknown',
    startLine: data.startLine ?? 0,
    endLine: data.endLine ?? 0,
    startColumn: data.startColumn ?? 0,
    endColumn: data.endColumn ?? 0,
    updatedAt: data.updatedAt ?? 0,
    ...(data.signature !== undefined ? { signature: data.signature } : {}),
    ...(data.docstring !== undefined ? { docstring: data.docstring } : {}),
  };
};

export interface SearchOptions {
  kind?: string | undefined;
  limit?: number | undefined;
}

// Which nodes a candidate list may return. `kinds` narrows to those types
// (rig_search's kind filter, skills, waypoints); `sourceOnly` keeps nodes that
// point into a file (anchors with a source body, for rig_context/rig_explore).
export interface CandidateFilter {
  kinds?: readonly string[] | undefined;
  sourceOnly?: boolean | undefined;
}

const filterSql = (f: CandidateFilter, params: unknown[]): string => {
  const parts: string[] = [];
  if (f.kinds && f.kinds.length > 0) {
    parts.push(`n.type IN (${f.kinds.map(() => '?').join(', ')})`);
    params.push(...f.kinds);
  }
  if (f.sourceOnly) parts.push(`COALESCE(json_extract(n.data, '$.filePath'), '') != ''`);
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
};

export const matchesFilter = (row: { type: string; data: string }, f: CandidateFilter): boolean => {
  if (f.kinds && f.kinds.length > 0 && !f.kinds.includes(row.type)) return false;
  if (f.sourceOnly) {
    const fp = (JSON.parse(row.data) as { filePath?: unknown }).filePath;
    if (typeof fp !== 'string' || fp === '') return false;
  }
  return true;
};

// bm25 column weights, in nodes_fts column order (v14): name, qualified_name,
// tokens, signature, docstring, text, node_id.
const BM25 = 'bm25(nodes_fts, 10.0, 5.0, 4.0, 2.0, 2.0, 1.0, 0.0)';

// The keyword list: nodes_fts (all columns for natural queries, the name-like
// ones for identifiers; see search/query.ts) plus alias FTS, best bm25 per
// node. An FTS5 syntax error (a query that tokenizes to nothing) is no match.
export const keywordCandidates = (
  db: SqliteAdapter,
  query: string,
  filter: CandidateFilter,
  limit: number,
): string[] => {
  const { fts } = parseQuery(query);
  if (!fts) return [];
  // Aliases are names: an alias query uses the same terms without the column
  // filter, which aliases_fts doesn't have.
  const aliasFts = fts.replace(/^\{[^}]*\} : /, '');
  const params: unknown[] = [fts];
  const f1 = filterSql(filter, params);
  params.push(aliasFts);
  const f2 = filterSql(filter, params);
  params.push(limit);
  const sql = `
    SELECT id, MIN(rank) AS rank FROM (
      SELECT n.id, ${BM25} AS rank
      FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
      WHERE nodes_fts MATCH ? ${f1}
      UNION ALL
      SELECT n.id, bm25(aliases_fts) AS rank
      FROM aliases_fts JOIN nodes n ON n.id = aliases_fts.node_id
      WHERE aliases_fts MATCH ? ${f2}
    )
    GROUP BY id
    ORDER BY rank, id
    LIMIT ?
  `;
  try {
    return (db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id);
  } catch (e) {
    if (/fts5|syntax error|unterminated|no such column/i.test(String(e))) return [];
    throw e;
  }
};

// Definitions before mentions when several nodes share a name: the class
// AuthStore before an `AuthStore` import or property.
const KIND_RANK: Record<string, number> = {
  class: 0,
  interface: 0,
  function: 0,
  method: 0,
  struct: 0,
  trait: 0,
  protocol: 0,
  enum: 0,
  type_alias: 0,
  component: 0,
  route: 0,
  namespace: 1,
  module: 1,
  constant: 1,
  variable: 2,
  property: 2,
  field: 2,
  enum_member: 2,
};
const kindRank = (t: string): number => KIND_RANK[t] ?? 3;

interface ExactRow {
  id: string;
  type: string;
  name: string;
  qn: string | null;
}

// Exact matches of the whole query: nodes whose name is the query or one of
// its identifier spellings (nameVariants), nodes whose qualified name is the
// query (identifier queries only), and nodes with such an alias. Best match
// first: the name as typed, then other spellings, then by kind (definitions
// first) and qualified-name length.
export const exactCandidates = (
  db: SqliteAdapter,
  query: string,
  filter: CandidateFilter,
): { name: string[]; alias: string[] } => {
  const typed = query.trim();
  const variants = nameVariants(typed);
  if (variants.length === 0) return { name: [], alias: [] };
  const lowerTyped = typed.toLowerCase();
  const tier = (s: string): number => (s === typed ? 0 : s.toLowerCase() === lowerTyped ? 1 : 2);

  const params: unknown[] = [...variants];
  const where = filterSql(filter, params);
  const byName = db
    .prepare(
      `SELECT n.id, n.type, n.name, json_extract(n.data, '$.qualifiedName') AS qn FROM nodes n
       WHERE n.name IN (${variants.map(() => '?').join(', ')}) ${where}`,
    )
    .all(...params) as ExactRow[];

  // Qualified names have no plain index; FTS narrows to rows holding the
  // phrase, then the comparison is exact (case-insensitive).
  const byQn: ExactRow[] = [];
  if (queryShape(typed) === 'identifier' && /[.:#/]/.test(typed)) {
    const qp: unknown[] = [`{qualified_name} : "${typed.replace(/"/g, '""')}"`];
    const qw = filterSql(filter, qp);
    try {
      const rows = db
        .prepare(
          `SELECT n.id, n.type, n.name, json_extract(n.data, '$.qualifiedName') AS qn
           FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
           WHERE nodes_fts MATCH ? ${qw} LIMIT 200`,
        )
        .all(...qp) as ExactRow[];
      for (const r of rows) if ((r.qn ?? '').toLowerCase() === lowerTyped) byQn.push(r);
    } catch {
      // a query FTS can't parse has no qualified-name match
    }
  }

  const ranked = new Map<string, { row: ExactRow; t: number }>();
  for (const r of byName) ranked.set(r.id, { row: r, t: tier(r.name) });
  for (const r of byQn) if (!ranked.has(r.id)) ranked.set(r.id, { row: r, t: tier(r.qn ?? '') });
  const name = [...ranked.values()]
    .sort(
      (a, b) =>
        a.t - b.t ||
        kindRank(a.row.type) - kindRank(b.row.type) ||
        (a.row.qn ?? a.row.name).length - (b.row.qn ?? b.row.name).length ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
    )
    .slice(0, EXACT_LIST_CAP)
    .map((e) => e.row.id);

  const lowerVariants = [...new Set(variants.map((v) => v.toLowerCase()))];
  const ap: unknown[] = [...lowerVariants];
  const aw = filterSql(filter, ap);
  const alias = (
    db
      .prepare(
        `SELECT DISTINCT n.id, n.type, MIN(CASE WHEN a.alias = ? THEN 0 ELSE 1 END) AS t
         FROM aliases a JOIN nodes n ON n.id = a.node_id
         WHERE lower(a.alias) IN (${lowerVariants.map(() => '?').join(', ')}) ${aw}
         GROUP BY n.id
         ORDER BY t, n.id
         LIMIT ${EXACT_LIST_CAP}`,
      )
      .all(typed, ...ap) as { id: string }[]
  ).map((r) => r.id);
  return { name, alias };
};

export interface ScoredId {
  id: string;
  score: number;
  matchedBy: MatchSource[];
}

// Candidate pool per list: enough below the requested limit that fusion can
// reorder, without scanning the whole index.
export const poolSize = (limit: number): number => Math.max(50, limit * 3);

export const exactAndKeywordLists = (
  db: SqliteAdapter,
  query: string,
  filter: CandidateFilter,
  limit: number,
): RankedList[] => {
  const exact = exactCandidates(db, query, filter);
  return [
    { source: 'name', ids: exact.name, weight: EXACT_WEIGHT },
    { source: 'alias', ids: exact.alias, weight: EXACT_WEIGHT },
    { source: 'keyword', ids: keywordCandidates(db, query, filter, poolSize(limit)) },
  ];
};

// Fetch the nodes of fused ids, in order, dropping any that no longer exist
// or no longer pass the filter (a vector index can trail the nodes table).
export const loadRanked = (
  db: SqliteAdapter,
  fused: readonly ScoredId[],
  filter: CandidateFilter,
  limit: number,
): { node: Node; score: number; matchedBy: MatchSource[] }[] => {
  const out: { node: Node; score: number; matchedBy: MatchSource[] }[] = [];
  const get = db.prepare(`SELECT id, type, name, data FROM nodes WHERE id = ?`);
  for (const f of fused) {
    if (out.length >= limit) break;
    const row = get.get(f.id) as NodeRow | null;
    if (!row || !matchesFilter(row, filter)) continue;
    out.push({ node: rowToNode(row), score: f.score, matchedBy: f.matchedBy });
  }
  return out;
};

// Keyword search without vectors: exact name/alias matches first, then FTS
// hits, fused by RRF. Synchronous; `Rig.search` adds the vector list.
export const searchScored = (
  db: SqliteAdapter,
  query: string,
  opts: SearchOptions & CandidateFilter = {},
): { node: Node; score: number; matchedBy: MatchSource[] }[] => {
  const limit = opts.limit ?? 20;
  if (!query.trim()) return [];
  const filter: CandidateFilter = {
    kinds: opts.kinds ?? (opts.kind ? [opts.kind] : undefined),
    sourceOnly: opts.sourceOnly,
  };
  const fused = fuseRrf(exactAndKeywordLists(db, query, filter, limit));
  return loadRanked(db, fused, filter, limit);
};

export const searchNodes = (db: SqliteAdapter, query: string, opts: SearchOptions = {}): Node[] =>
  searchScored(db, query, opts).map((h) => h.node);
