// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './db/adapter.ts';
import { DERIVED_EDGE_SQL, EXTRACTED_NODE_SQL } from './db/extracted-nodes.ts';
import { nodesAtAnchor, type OrphanAnchor, type OrphanPayload } from './db/orphaned-memory.ts';
import { parseSourceUrls } from './db/pending-edges.ts';
import { CALLABLE_KINDS } from './reconcile-nodes.ts';

// The memory file behind `rig export-memory` / `rig import-memory`: the
// agent-written layer of the graph as JSONL, so it can outlive .rig/ (which
// `rig init` gitignores, so a fresh clone or `git clean -fdx` loses it).
//
// One JSON record per line, each with a `type`. The first is the header
// {type: 'header', format: 'rig-memory', version: 1, schema_version, note};
// then, in this order and sorted within each type, so that two exports of the
// same graph are byte-identical:
//   session        sessions rows
//   node           nodes agents created (rig_add_node, rig_cluster)
//   waypoint       conversation waypoints, data as stored (rationale included)
//   edge           edges agents wrote: waypoint_succeeds, waypoint_references,
//                  cluster `contains`
//   alias, annotation, promotion (hub_explicit), semantic_edge (accepted
//   proposals, with kind and source_urls), pending_edge (every status)
//   orphan         orphaned_memory rows, payload as stored
// A node reference is {id, key?}: the raw id, plus for a code (extracted) node
// its portable key {kind, filePath, qualifiedName, name, ordinal?}; ordinal is
// there only when other nodes share the anchor. Agent-written nodes keep their
// ids. Free-form JSON (node and waypoint data, orphan payloads) is written with
// sorted keys.
//
// Import matches a code reference by raw id first, then by portable key, with
// retention's anchor lookup (nodesAtAnchor, plus its function <-> method
// fallback). The memory of a code node it cannot find waits in orphaned_memory
// (reason 'import-unmatched', retention's payload format) and re-attaches when
// the symbol is indexed. An `orphan` record whose symbol is here is restored
// at once; otherwise it is kept as an orphan row, reason unchanged.
//
// Import only adds. An item the graph already has (same identity) is left as
// it is, whichever side is newer: a session keeps its last_seen, a proposal
// its status, a waypoint its data. So importing a file twice changes nothing
// the second time. Something deleted after the export (an undone alias, say)
// does come back if that export is imported again.

export const MEMORY_FORMAT = 'rig-memory';
export const MEMORY_FORMAT_VERSION = 1;

const HEADER_NOTE =
  'rig agent memory (rig import-memory reads it). It can contain conversation-derived ' +
  'text: waypoint summaries and payloads.';

export const MEMORY_RECORD_TYPES = [
  'session',
  'node',
  'waypoint',
  'edge',
  'alias',
  'annotation',
  'promotion',
  'semantic_edge',
  'pending_edge',
  'orphan',
] as const;
export type MemoryRecordType = (typeof MEMORY_RECORD_TYPES)[number];

export interface PortableKey {
  kind: string;
  filePath: string;
  qualifiedName: string;
  name: string;
  ordinal?: number;
}

export interface NodeRef {
  id: string;
  key?: PortableKey;
}

type PendingStatus = 'pending' | 'accepted' | 'rejected';

interface SessionRec {
  type: 'session';
  id: string;
  started_at: number;
  last_seen: number;
  title: string | null;
  context_model: string | null;
}
interface NodeRec {
  type: 'node';
  id: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}
interface WaypointRec {
  type: 'waypoint';
  id: string;
  title: string;
  data: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}
interface EdgeRec {
  type: 'edge';
  src: NodeRef;
  dst: NodeRef;
  kind: string;
  provenance: string;
  created_at: number;
}
interface AliasRec {
  type: 'alias';
  node: NodeRef;
  alias: string;
  provenance: string;
  rationale: string | null;
  created_at: number;
}
interface AnnotationRec {
  type: 'annotation';
  id: number;
  node: NodeRef;
  note: string;
  ts: number;
  actor: string;
  rationale: string | null;
}
interface PromotionRec {
  type: 'promotion';
  node: NodeRef;
}
interface SemanticEdgeRec {
  type: 'semantic_edge';
  src: NodeRef;
  dst: NodeRef;
  kind: string;
  weight: number;
  provenance: string;
  rationale: string | null;
  source_urls: string[];
  created_at: number;
}
interface PendingEdgeRec {
  type: 'pending_edge';
  id: number;
  src: NodeRef;
  dst: NodeRef;
  kind: string;
  weight: number;
  provenance: string;
  rationale: string;
  proposed_at: number;
  session_id: string;
  status: PendingStatus;
  source_urls: string[];
}
interface OrphanRec {
  type: 'orphan';
  node_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  payload: OrphanPayload;
  orphaned_at: number;
  reason: string;
}
type MemoryRecord =
  | SessionRec
  | NodeRec
  | WaypointRec
  | EdgeRec
  | AliasRec
  | AnnotationRec
  | PromotionRec
  | SemanticEdgeRec
  | PendingEdgeRec
  | OrphanRec;

export class MemoryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryFileError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Plain objects with their keys sorted, recursively, so free-form JSON
// serializes the same however it was stored.
const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canonical(v[k])]),
  );
};

const urlsJson = (urls: readonly string[]): string | null =>
  urls.length ? JSON.stringify(urls) : null;

// ---------------------------------------------------------------- export

export interface MemoryExport {
  text: string;
  // Records written, by type (every type, 0 included).
  counts: Record<MemoryRecordType, number>;
}

export const exportMemory = (db: SqliteAdapter): MemoryExport =>
  // One transaction: a consistent snapshot while other processes write.
  db.transaction((): MemoryExport => {
    const counts = Object.fromEntries(MEMORY_RECORD_TYPES.map((t) => [t, 0])) as Record<
      MemoryRecordType,
      number
    >;
    const schema = db.prepare(`SELECT MAX(version) AS v FROM schema_versions`).get() as {
      v: number;
    };
    const lines = [
      JSON.stringify({
        type: 'header',
        format: MEMORY_FORMAT,
        version: MEMORY_FORMAT_VERSION,
        schema_version: schema.v,
        note: HEADER_NOTE,
      }),
    ];
    const emit = (rec: MemoryRecord): void => {
      lines.push(JSON.stringify(rec));
      counts[rec.type]++;
    };
    const all = <T>(sql: string, ...params: unknown[]): T[] =>
      db.prepare(sql).all(...params) as T[];

    const codeNode = db.prepare(
      `SELECT n.type, n.name, n.data FROM nodes n WHERE n.id = ? AND ${EXTRACTED_NODE_SQL}`,
    );
    const atAnchor = nodesAtAnchor(db);
    const refs = new Map<string, NodeRef>();
    const refOf = (id: string): NodeRef => {
      const cached = refs.get(id);
      if (cached) return cached;
      const row = codeNode.get(id) as { type: string; name: string; data: string } | null;
      let ref: NodeRef = { id };
      if (row) {
        const d = JSON.parse(row.data) as { filePath: string; qualifiedName?: string };
        const qualifiedName = d.qualifiedName ?? row.name;
        const holders = atAnchor(d.filePath, row.type, qualifiedName);
        ref = {
          id,
          key: {
            kind: row.type,
            filePath: d.filePath,
            qualifiedName,
            name: row.name,
            ...(holders.length > 1 ? { ordinal: holders.indexOf(id) } : {}),
          },
        };
      }
      refs.set(id, ref);
      return ref;
    };

    for (const r of all<Omit<SessionRec, 'type'>>(
      `SELECT id, started_at, last_seen, title, context_model FROM sessions ORDER BY id`,
    )) {
      emit({ type: 'session', ...r });
    }
    // Agent-created nodes: neither extracted, a waypoint, nor a skill (skills
    // are re-seeded from the tool manifest).
    for (const r of all<{
      id: string;
      type: string;
      name: string;
      data: string;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT n.id, n.type, n.name, n.data, n.created_at, n.updated_at FROM nodes n
       WHERE n.type NOT IN ('conversation-waypoint', 'skill') AND NOT COALESCE((${EXTRACTED_NODE_SQL}), 0)
       ORDER BY n.id`,
    )) {
      emit({
        type: 'node',
        id: r.id,
        kind: r.type,
        name: r.name,
        data: canonical(JSON.parse(r.data)) as Record<string, unknown>,
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
    for (const r of all<{
      id: string;
      name: string;
      data: string;
      created_at: number;
      updated_at: number;
    }>(
      // Waypoints list newest first, ties by insertion order: import keeps it.
      `SELECT id, name, data, created_at, updated_at FROM nodes
       WHERE type = 'conversation-waypoint' ORDER BY created_at, rowid`,
    )) {
      emit({
        type: 'waypoint',
        id: r.id,
        title: r.name,
        data: canonical(JSON.parse(r.data)) as Record<string, unknown>,
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
    for (const r of all<{
      src: string;
      dst: string;
      kind: string;
      provenance: string;
      created_at: number;
    }>(
      `SELECT src, dst, kind, provenance, created_at FROM edges WHERE NOT ${DERIVED_EDGE_SQL()}
       ORDER BY kind, src, dst`,
    )) {
      emit({
        type: 'edge',
        src: refOf(r.src),
        dst: refOf(r.dst),
        kind: r.kind,
        provenance: r.provenance,
        created_at: r.created_at,
      });
    }
    for (const r of all<{
      node_id: string;
      alias: string;
      provenance: string;
      rationale: string | null;
      created_at: number;
    }>(
      `SELECT node_id, alias, provenance, rationale, created_at FROM aliases
       ORDER BY node_id, alias`,
    )) {
      emit({
        type: 'alias',
        node: refOf(r.node_id),
        alias: r.alias,
        provenance: r.provenance,
        rationale: r.rationale,
        created_at: r.created_at,
      });
    }
    for (const r of all<{
      id: number;
      node_id: string;
      note: string;
      ts: number;
      actor: string;
      rationale: string | null;
    }>(`SELECT id, node_id, note, ts, actor, rationale FROM annotations ORDER BY id`)) {
      emit({
        type: 'annotation',
        id: r.id,
        node: refOf(r.node_id),
        note: r.note,
        ts: r.ts,
        actor: r.actor,
        rationale: r.rationale,
      });
    }
    for (const r of all<{ id: string }>(
      `SELECT id FROM nodes WHERE hub_explicit = 1 ORDER BY id`,
    )) {
      emit({ type: 'promotion', node: refOf(r.id) });
    }
    for (const r of all<{
      src: string;
      dst: string;
      kind: string;
      weight: number;
      provenance: string;
      rationale: string | null;
      source_urls: string | null;
      created_at: number;
    }>(
      `SELECT src, dst, kind, weight, provenance, rationale, source_urls, created_at
       FROM edges_semantic ORDER BY src, dst, provenance`,
    )) {
      emit({
        type: 'semantic_edge',
        src: refOf(r.src),
        dst: refOf(r.dst),
        kind: r.kind,
        weight: r.weight,
        provenance: r.provenance,
        rationale: r.rationale,
        source_urls: parseSourceUrls(r.source_urls),
        created_at: r.created_at,
      });
    }
    for (const r of all<{
      id: number;
      src: string;
      dst: string;
      kind: string;
      weight: number;
      provenance: string;
      rationale: string;
      proposed_at: number;
      session_id: string;
      status: PendingStatus;
      source_urls: string | null;
    }>(
      `SELECT id, src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status,
              source_urls
       FROM pending_edges ORDER BY id`,
    )) {
      emit({
        type: 'pending_edge',
        id: r.id,
        src: refOf(r.src),
        dst: refOf(r.dst),
        kind: r.kind,
        weight: r.weight,
        provenance: r.provenance,
        rationale: r.rationale,
        proposed_at: r.proposed_at,
        session_id: r.session_id,
        status: r.status,
        source_urls: parseSourceUrls(r.source_urls),
      });
    }
    for (const r of all<Omit<OrphanRec, 'type' | 'payload'> & { payload: string }>(
      `SELECT node_id, kind, name, qualified_name, file_path, payload, orphaned_at, reason
       FROM orphaned_memory
       ORDER BY file_path, kind, qualified_name, orphaned_at, node_id, reason, id`,
    )) {
      emit({
        type: 'orphan',
        ...r,
        payload: canonical(JSON.parse(r.payload)) as OrphanPayload,
      });
    }
    return { text: lines.join('\n') + '\n', counts };
  })();

// ---------------------------------------------------------------- parsing

type Field = 'string' | 'number' | 'string|null' | 'ref' | 'object' | 'strings';

const FIELDS: Record<MemoryRecordType, Record<string, Field>> = {
  session: {
    id: 'string',
    started_at: 'number',
    last_seen: 'number',
    title: 'string|null',
    context_model: 'string|null',
  },
  node: {
    id: 'string',
    kind: 'string',
    name: 'string',
    data: 'object',
    created_at: 'number',
    updated_at: 'number',
  },
  waypoint: {
    id: 'string',
    title: 'string',
    data: 'object',
    created_at: 'number',
    updated_at: 'number',
  },
  edge: { src: 'ref', dst: 'ref', kind: 'string', provenance: 'string', created_at: 'number' },
  alias: {
    node: 'ref',
    alias: 'string',
    provenance: 'string',
    rationale: 'string|null',
    created_at: 'number',
  },
  annotation: {
    id: 'number',
    node: 'ref',
    note: 'string',
    ts: 'number',
    actor: 'string',
    rationale: 'string|null',
  },
  promotion: { node: 'ref' },
  semantic_edge: {
    src: 'ref',
    dst: 'ref',
    kind: 'string',
    weight: 'number',
    provenance: 'string',
    rationale: 'string|null',
    source_urls: 'strings',
    created_at: 'number',
  },
  pending_edge: {
    id: 'number',
    src: 'ref',
    dst: 'ref',
    kind: 'string',
    weight: 'number',
    provenance: 'string',
    rationale: 'string',
    proposed_at: 'number',
    session_id: 'string',
    status: 'string',
    source_urls: 'strings',
  },
  orphan: {
    node_id: 'string',
    kind: 'string',
    name: 'string',
    qualified_name: 'string',
    file_path: 'string',
    payload: 'object',
    orphaned_at: 'number',
    reason: 'string',
  },
};

const isRef = (v: unknown): boolean => {
  if (!isObj(v) || typeof v.id !== 'string') return false;
  if (v.key === undefined) return true;
  const k = v.key;
  return (
    isObj(k) &&
    typeof k.kind === 'string' &&
    typeof k.filePath === 'string' &&
    typeof k.qualifiedName === 'string' &&
    typeof k.name === 'string' &&
    (k.ordinal === undefined || (Number.isInteger(k.ordinal) && (k.ordinal as number) >= 0))
  );
};

const fieldOk = (field: Field, v: unknown): boolean => {
  switch (field) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'string|null':
      return v === null || typeof v === 'string';
    case 'ref':
      return isRef(v);
    case 'object':
      return isObj(v);
    case 'strings':
      return Array.isArray(v) && v.every((s) => typeof s === 'string');
  }
};

// Read a memory file: the header, then records, checked field by field.
// Throws MemoryFileError naming the line.
export const parseMemoryFile = (text: string): MemoryRecord[] => {
  const out: MemoryRecord[] = [];
  let header = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const at = `line ${i + 1}`;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new MemoryFileError(
        header ? `${at}: not valid JSON` : `not a rig memory export: ${at} is not JSON`,
      );
    }
    if (!isObj(rec) || typeof rec.type !== 'string') {
      throw new MemoryFileError(`${at}: a record needs a "type"`);
    }
    if (!header) {
      if (rec.type !== 'header' || rec.format !== MEMORY_FORMAT) {
        throw new MemoryFileError(
          `not a rig memory export: ${at} is not a "${MEMORY_FORMAT}" header`,
        );
      }
      if (rec.version !== MEMORY_FORMAT_VERSION) {
        throw new MemoryFileError(
          `memory export format version ${String(rec.version)} is not supported ` +
            `(this rig reads version ${MEMORY_FORMAT_VERSION}); update rig`,
        );
      }
      header = true;
      continue;
    }
    if (!Object.hasOwn(FIELDS, rec.type)) {
      throw new MemoryFileError(`${at}: unknown record type "${rec.type}"`);
    }
    const type = rec.type as MemoryRecordType;
    for (const [name, field] of Object.entries(FIELDS[type])) {
      if (!fieldOk(field, rec[name])) {
        throw new MemoryFileError(`${at}: ${type}.${name} is missing or not a ${field}`);
      }
    }
    if (
      type === 'pending_edge' &&
      !['pending', 'accepted', 'rejected'].includes(String(rec.status))
    ) {
      throw new MemoryFileError(`${at}: pending_edge.status must be pending, accepted or rejected`);
    }
    if (type === 'node' && ['conversation-waypoint', 'skill'].includes(String(rec.kind))) {
      throw new MemoryFileError(`${at}: a ${String(rec.kind)} is not a node record`);
    }
    out.push(rec as unknown as MemoryRecord);
  }
  if (!header) throw new MemoryFileError('empty file: not a rig memory export');
  return out;
};

// ---------------------------------------------------------------- import

// added: written now. present: the graph already had it, and it was left as
// it is. orphaned: it refers to a code node not found here, and waits in
// orphaned_memory until the symbol is indexed. dropped: it refers to an
// agent-written node that neither the file nor the graph has.
export interface MemoryImportCounts {
  added: number;
  present: number;
  orphaned: number;
  dropped: number;
}

export interface MemoryImportResult {
  // By record type, for the types the file holds.
  records: Partial<Record<MemoryRecordType, MemoryImportCounts>>;
  // orphaned_memory rows written or extended.
  orphanRows: number;
}

type Outcome = keyof MemoryImportCounts;
type KeyedRef = NodeRef & { key: PortableKey };
type EdgeList = 'semantic_edges' | 'pending_edges' | 'edges';
type EdgeItem = { src: string; dst: string };

// An imported waypoint or cluster lists node ids in its data; one that the
// import found under another id is rewritten, as retention's re-attach does.
const REF_FIELD: Record<string, string> = {
  waypoint_references: 'constellation_refs',
  contains: 'members',
};

const emptyPayload = (ordinal: number): OrphanPayload => ({
  v: 1,
  ordinal,
  hub_explicit: false,
  aliases: [],
  annotations: [],
  semantic_edges: [],
  pending_edges: [],
  edges: [],
  anchors: {},
});

const normalizePayload = (raw: unknown): OrphanPayload => {
  const p = isObj(raw) ? raw : {};
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    v: 1,
    ordinal: typeof p.ordinal === 'number' ? p.ordinal : 0,
    hub_explicit: p.hub_explicit === true,
    aliases: list(p.aliases),
    annotations: list(p.annotations),
    semantic_edges: list(p.semantic_edges),
    pending_edges: list(p.pending_edges),
    edges: list(p.edges),
    anchors: isObj(p.anchors) ? (p.anchors as Record<string, OrphanAnchor>) : {},
  };
};

const keyOfAnchor = (a: OrphanAnchor): PortableKey => ({
  kind: a.kind,
  filePath: a.file_path,
  qualifiedName: a.qualified_name,
  name: a.name ?? a.qualified_name,
  ordinal: a.ordinal ?? 0,
});

const anchorOfKey = (k: PortableKey): OrphanAnchor => ({
  file_path: k.filePath,
  kind: k.kind,
  qualified_name: k.qualifiedName,
  name: k.name,
  ordinal: k.ordinal ?? 0,
});

const sameKind = (a: string, b: string): boolean =>
  a === b || (CALLABLE_KINDS.has(a) && CALLABLE_KINDS.has(b));

// Memory of a code node not found here, by its id in the file: the
// 'import-unmatched' row already waiting for it, if any, and what this import
// adds to it.
interface Parked {
  ref: KeyedRef;
  existing: { rowId: number; payload: OrphanPayload } | null;
  added: OrphanPayload | null;
}

const runImport = (db: SqliteAdapter, records: readonly MemoryRecord[]): MemoryImportResult => {
  const result: MemoryImportResult = { records: {}, orphanRows: 0 };
  const nodeRow = db.prepare(`SELECT id, type, name, data FROM nodes WHERE id = ?`);
  const codeNode = db.prepare(
    `SELECT n.type, n.name, n.data FROM nodes n WHERE n.id = ? AND ${EXTRACTED_NODE_SQL}`,
  );
  const atAnchor = nodesAtAnchor(db);

  // ---- references
  // A code reference: the raw id when that node is the same symbol, else the
  // node now at the portable key (by ordinal), else a callable of the other
  // kind there (retention's function <-> method fallback).
  const findCode = (id: string, key: PortableKey): string | null => {
    const row = nodeRow.get(id) as { type: string; name: string; data: string } | null;
    if (row && sameKind(row.type, key.kind)) {
      const d = JSON.parse(row.data) as { filePath?: string; qualifiedName?: string };
      // Same id, same file: the same symbol, its anchor maybe changed in place
      // (a dependency's spec, a renamed class) — unless another node holds
      // the exported anchor now (a position-keyed id handed to a new symbol).
      if (
        d.filePath === key.filePath &&
        ((d.qualifiedName ?? row.name) === key.qualifiedName ||
          atAnchor(key.filePath, key.kind, key.qualifiedName).length === 0)
      ) {
        return id;
      }
    }
    const ordinal = key.ordinal ?? 0;
    const kinds = CALLABLE_KINDS.has(key.kind)
      ? [key.kind, ...[...CALLABLE_KINDS].filter((k) => k !== key.kind)]
      : [key.kind];
    for (const kind of kinds) {
      const hit = atAnchor(key.filePath, kind, key.qualifiedName)[ordinal];
      if (hit) return hit;
    }
    return null;
  };
  // Agent-written nodes are imported first, so a reference to one resolves
  // by id.
  const found = new Map<string, string | null>();
  const resolve = (ref: NodeRef): string | null => {
    const cached = found.get(ref.id);
    if (cached !== undefined) return cached;
    const id = ref.key ? findCode(ref.id, ref.key) : nodeRow.get(ref.id) ? ref.id : null;
    found.set(ref.id, id);
    return id;
  };
  const anchorOfNode = (id: string): OrphanAnchor | null => {
    const row = codeNode.get(id) as { type: string; name: string; data: string } | null;
    if (!row) return null;
    const d = JSON.parse(row.data) as { filePath: string; qualifiedName?: string };
    const qualifiedName = d.qualifiedName ?? row.name;
    return {
      file_path: d.filePath,
      kind: row.type,
      qualified_name: qualifiedName,
      name: row.name,
      ordinal: Math.max(0, atAnchor(d.filePath, row.type, qualifiedName).indexOf(id)),
    };
  };

  // ---- ids
  // Annotations and pending edges keep their exported id when nothing here
  // holds it. An item waiting in an orphan payload is re-attached under its
  // id, and re-attach takes an existing row with that id for "already back",
  // so its id is reserved: AUTOINCREMENT's sequence moves past it and no new
  // row takes it.
  const idSpace = (table: 'annotations' | 'pending_edges') => {
    const row = db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`);
    const waiting = db.prepare(
      `SELECT 1 AS x FROM orphaned_memory o, json_each(o.payload, '$.${table}') e
       WHERE json_extract(e.value, '$.id') = ? LIMIT 1`,
    );
    const seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`);
    const bump = db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`);
    const start = db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`);
    const reserved = new Set<number>();
    const free = (id: number): boolean =>
      Number.isInteger(id) && id > 0 && !reserved.has(id) && !row.get(id) && !waiting.get(id);
    return {
      // The exported id for a row inserted now, or null to let AUTOINCREMENT
      // pick one.
      forRow: (id: number): number | null => {
        if (!free(id)) return null;
        reserved.add(id);
        return id;
      },
      reserve: (preferred: number): number => {
        const next = ((seq.get(table) as { seq: number } | null)?.seq ?? 0) + 1;
        const id = free(preferred) ? preferred : next;
        if (bump.run(id, table).changes === 0) start.run(table, id);
        reserved.add(id);
        return id;
      },
    };
  };
  const ids = { annotations: idSpace('annotations'), pending_edges: idSpace('pending_edges') };

  // ---- parking
  const waitingRow = db.prepare(
    `SELECT id, payload FROM orphaned_memory
     WHERE reason = 'import-unmatched' AND node_id = ? AND file_path = ? AND kind = ?
       AND qualified_name = ?`,
  );
  const parked = new Map<string, Parked>();
  const parkedFor = (ref: KeyedRef): Parked => {
    let p = parked.get(ref.id);
    if (!p) {
      const row = waitingRow.get(ref.id, ref.key.filePath, ref.key.kind, ref.key.qualifiedName) as {
        id: number;
        payload: string;
      } | null;
      p = {
        ref,
        existing: row
          ? { rowId: row.id, payload: normalizePayload(JSON.parse(row.payload)) }
          : null,
        added: null,
      };
      parked.set(ref.id, p);
    }
    return p;
  };
  const payloadOf = (p: Parked): OrphanPayload =>
    (p.added ??= emptyPayload(p.ref.key.ordinal ?? 0));
  // Does the memory waiting for this node (written before, or added now) hold
  // an item?
  const holds = <T>(
    p: Parked,
    list: 'aliases' | 'annotations' | EdgeList,
    same: (item: T) => boolean,
  ): boolean =>
    [p.existing?.payload, p.added].some((pl) => !!pl && (pl[list] as unknown as T[]).some(same));

  // Memory on one node: written to it when found; when it is a code node not
  // found, it waits in that node's orphan payload; anything else is dropped.
  const onNode = (
    ref: NodeRef,
    write: (id: string) => boolean,
    park: (p: Parked) => boolean,
  ): Outcome => {
    const id = resolve(ref);
    if (id) return write(id) ? 'added' : 'present';
    if (!ref.key) return 'dropped';
    return park(parkedFor(ref as KeyedRef)) ? 'orphaned' : 'present';
  };

  // Ids of edges whose agent-written source lists them in its data (see
  // REF_FIELD), found here under another id: source id → (old → new).
  const rewrites = new Map<string, Map<string, string>>();

  // Memory linking two nodes: written when both ends are found. Otherwise it
  // waits in the payload of each code node not found, its found end by its id
  // here, with the anchors of its code ends so re-attach can find them.
  const onLink = <T extends EdgeItem>(
    src: NodeRef,
    dst: NodeRef,
    list: EdgeList,
    write: (s: string, d: string) => boolean,
    same: (item: T, s: string, d: string) => boolean,
    make: (s: string, d: string) => T,
  ): Outcome => {
    const s = resolve(src);
    const d = resolve(dst);
    if (s && d) return write(s, d) ? 'added' : 'present';
    const missing: NodeRef[] = [];
    if (!s) missing.push(src);
    if (!d && !(dst.id === src.id && !s)) missing.push(dst);
    if (missing.some((r) => !r.key)) return 'dropped';
    const se = s ?? src.id;
    const de = d ?? dst.id;
    const anchors: Record<string, OrphanAnchor> = {};
    for (const [ref, id] of [
      [src, s],
      [dst, d],
    ] as const) {
      const a = id ? anchorOfNode(id) : ref.key ? anchorOfKey(ref.key) : null;
      if (a) anchors[id ?? ref.id] = a;
    }
    let item: T | null = null;
    let added = false;
    for (const ref of missing) {
      const p = parkedFor(ref as KeyedRef);
      if (holds<T>(p, list, (e) => same(e, se, de))) continue;
      item ??= make(se, de);
      const pl = payloadOf(p);
      (pl[list] as unknown as T[]).push(item);
      for (const [end, a] of Object.entries(anchors)) if (end !== ref.id) pl.anchors[end] = a;
      added = true;
    }
    return added ? 'orphaned' : 'present';
  };

  // ---- writers
  const sql = {
    session: db.prepare(
      `INSERT OR IGNORE INTO sessions (id, started_at, last_seen, title, context_model)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    node: db.prepare(
      `INSERT INTO nodes (id, type, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    edge: db.prepare(
      `INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    alias: db.prepare(
      `INSERT OR IGNORE INTO aliases (node_id, alias, provenance, rationale, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    annotationLike: db.prepare(
      `SELECT 1 AS x FROM annotations WHERE node_id = ? AND note = ? AND ts = ? AND actor = ?`,
    ),
    annotation: db.prepare(
      `INSERT INTO annotations (id, node_id, note, ts, actor, rationale) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    hub: db.prepare(`SELECT hub_explicit FROM nodes WHERE id = ?`),
    promote: db.prepare(
      `UPDATE nodes SET hub_explicit = 1, is_hub = 1, hubness = MAX(hubness, 0.3) WHERE id = ?`,
    ),
    semantic: db.prepare(
      `INSERT OR IGNORE INTO edges_semantic
         (src, dst, weight, provenance, rationale, created_at, kind, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    pendingLike: db.prepare(
      `SELECT 1 AS x FROM pending_edges WHERE src = ? AND dst = ? AND kind = ? AND provenance = ?
         AND rationale = ? AND proposed_at = ? AND session_id = ?`,
    ),
    pending: db.prepare(
      `INSERT INTO pending_edges
         (id, src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    orphanLike: db.prepare(
      `SELECT 1 AS x FROM orphaned_memory WHERE node_id = ? AND kind = ? AND qualified_name = ?
         AND file_path = ? AND orphaned_at = ? AND reason = ?`,
    ),
    orphan: db.prepare(
      `INSERT INTO orphaned_memory
         (node_id, kind, name, qualified_name, file_path, payload, orphaned_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    waitingPayload: db.prepare(`UPDATE orphaned_memory SET payload = ? WHERE id = ?`),
    data: db.prepare(`SELECT data FROM nodes WHERE id = ?`),
    setData: db.prepare(`UPDATE nodes SET data = ? WHERE id = ?`),
  };

  const importNode = (
    id: string,
    type: string,
    name: string,
    r: NodeRec | WaypointRec,
  ): Outcome => {
    if (nodeRow.get(id)) return 'present';
    sql.node.run(id, type, name, JSON.stringify(r.data), r.created_at, r.updated_at);
    return 'added';
  };

  const importEdge = (r: Omit<EdgeRec, 'type'>): Outcome =>
    onLink<OrphanPayload['edges'][number]>(
      r.src,
      r.dst,
      'edges',
      (s, d) => {
        const field = REF_FIELD[r.kind];
        if (field && d !== r.dst.id) {
          let m = rewrites.get(s);
          if (!m) rewrites.set(s, (m = new Map()));
          m.set(r.dst.id, d);
        }
        return sql.edge.run(s, d, r.kind, r.provenance, r.created_at).changes > 0;
      },
      (e, s, d) => e.src === s && e.dst === d && e.kind === r.kind,
      (s, d) => ({
        src: s,
        dst: d,
        kind: r.kind,
        provenance: r.provenance,
        created_at: r.created_at,
      }),
    );

  const importAlias = (r: Omit<AliasRec, 'type'>): Outcome =>
    onNode(
      r.node,
      (id) => sql.alias.run(id, r.alias, r.provenance, r.rationale, r.created_at).changes > 0,
      (p) => {
        if (holds<{ alias: string }>(p, 'aliases', (a) => a.alias === r.alias)) return false;
        payloadOf(p).aliases.push({
          alias: r.alias,
          provenance: r.provenance,
          rationale: r.rationale,
          created_at: r.created_at,
        });
        return true;
      },
    );

  const importAnnotation = (r: Omit<AnnotationRec, 'type'>): Outcome =>
    onNode(
      r.node,
      (id) => {
        if (sql.annotationLike.get(id, r.note, r.ts, r.actor)) return false;
        sql.annotation.run(ids.annotations.forRow(r.id), id, r.note, r.ts, r.actor, r.rationale);
        return true;
      },
      (p) => {
        const same = (a: { note: string; ts: number; actor: string }): boolean =>
          a.note === r.note && a.ts === r.ts && a.actor === r.actor;
        if (holds(p, 'annotations', same)) return false;
        payloadOf(p).annotations.push({
          id: ids.annotations.reserve(r.id),
          note: r.note,
          ts: r.ts,
          actor: r.actor,
          rationale: r.rationale,
        });
        return true;
      },
    );

  const importPromotion = (node: NodeRef): Outcome =>
    onNode(
      node,
      (id) => {
        if ((sql.hub.get(id) as { hub_explicit: number }).hub_explicit === 1) return false;
        sql.promote.run(id);
        return true;
      },
      (p) => {
        if (p.existing?.payload.hub_explicit || p.added?.hub_explicit) return false;
        payloadOf(p).hub_explicit = true;
        return true;
      },
    );

  const importSemantic = (r: Omit<SemanticEdgeRec, 'type'>): Outcome =>
    onLink<OrphanPayload['semantic_edges'][number]>(
      r.src,
      r.dst,
      'semantic_edges',
      (s, d) =>
        sql.semantic.run(
          s,
          d,
          r.weight,
          r.provenance,
          r.rationale,
          r.created_at,
          r.kind,
          urlsJson(r.source_urls),
        ).changes > 0,
      (e, s, d) => e.src === s && e.dst === d && e.provenance === r.provenance,
      (s, d) => ({
        src: s,
        dst: d,
        weight: r.weight,
        provenance: r.provenance,
        rationale: r.rationale,
        created_at: r.created_at,
        kind: r.kind,
        source_urls: urlsJson(r.source_urls),
      }),
    );

  const importPending = (r: Omit<PendingEdgeRec, 'type'>): Outcome =>
    onLink<OrphanPayload['pending_edges'][number]>(
      r.src,
      r.dst,
      'pending_edges',
      (s, d) => {
        if (
          sql.pendingLike.get(s, d, r.kind, r.provenance, r.rationale, r.proposed_at, r.session_id)
        ) {
          return false;
        }
        sql.pending.run(
          ids.pending_edges.forRow(r.id),
          s,
          d,
          r.kind,
          r.weight,
          r.provenance,
          r.rationale,
          r.proposed_at,
          r.session_id,
          r.status,
          urlsJson(r.source_urls),
        );
        return true;
      },
      (e, s, d) =>
        e.src === s &&
        e.dst === d &&
        e.kind === r.kind &&
        e.provenance === r.provenance &&
        e.rationale === r.rationale &&
        e.proposed_at === r.proposed_at &&
        e.session_id === r.session_id,
      (s, d) => ({
        id: ids.pending_edges.reserve(r.id),
        src: s,
        dst: d,
        kind: r.kind,
        weight: r.weight,
        provenance: r.provenance,
        rationale: r.rationale,
        proposed_at: r.proposed_at,
        session_id: r.session_id,
        status: r.status,
        source_urls: urlsJson(r.source_urls),
      }),
    );

  // An orphan record whose symbol is here: its memory is restored now, item
  // by item, like the records above. Otherwise it is kept as an orphan row,
  // its waiting items' ids reserved.
  const importOrphan = (r: OrphanRec): Outcome => {
    const p = normalizePayload(r.payload);
    const self: KeyedRef = {
      id: r.node_id,
      key: {
        kind: r.kind,
        filePath: r.file_path,
        qualifiedName: r.qualified_name,
        name: r.name,
        ordinal: p.ordinal,
      },
    };
    if (resolve(self)) {
      const refOf = (id: string): NodeRef => {
        if (id === self.id) return self;
        const a = p.anchors[id];
        return a ? { id, key: keyOfAnchor(a) } : { id };
      };
      const outcomes: Outcome[] = [
        ...p.aliases.map((a) => importAlias({ node: self, ...a })),
        ...p.annotations.map((a) => importAnnotation({ ...a, node: self })),
        ...(p.hub_explicit ? [importPromotion(self)] : []),
        ...p.semantic_edges.map((e) =>
          importSemantic({
            src: refOf(e.src),
            dst: refOf(e.dst),
            kind: e.kind ?? 'related',
            weight: e.weight,
            provenance: e.provenance,
            rationale: e.rationale,
            source_urls: parseSourceUrls(e.source_urls ?? null),
            created_at: e.created_at,
          }),
        ),
        ...p.pending_edges.map((e) =>
          importPending({
            ...e,
            src: refOf(e.src),
            dst: refOf(e.dst),
            status: e.status as PendingStatus,
            source_urls: parseSourceUrls(e.source_urls),
          }),
        ),
        ...p.edges.map((e) => importEdge({ ...e, src: refOf(e.src), dst: refOf(e.dst) })),
      ];
      return outcomes.some((o) => o === 'added' || o === 'orphaned') ? 'added' : 'present';
    }
    if (
      sql.orphanLike.get(r.node_id, r.kind, r.qualified_name, r.file_path, r.orphaned_at, r.reason)
    ) {
      return 'present';
    }
    const payload: OrphanPayload = {
      ...p,
      annotations: p.annotations.map((a) => ({ ...a, id: ids.annotations.reserve(a.id) })),
      pending_edges: p.pending_edges.map((e) => ({ ...e, id: ids.pending_edges.reserve(e.id) })),
    };
    sql.orphan.run(
      r.node_id,
      r.kind,
      r.name,
      r.qualified_name,
      r.file_path,
      JSON.stringify(payload),
      r.orphaned_at,
      r.reason,
    );
    result.orphanRows++;
    return 'orphaned';
  };

  // ---- run, nodes first so references to them resolve
  const order = new Map(MEMORY_RECORD_TYPES.map((t, i) => [t, i]));
  const sorted = [...records].sort((a, b) => order.get(a.type)! - order.get(b.type)!);
  for (const r of sorted) {
    let outcome: Outcome;
    switch (r.type) {
      case 'session':
        outcome =
          sql.session.run(r.id, r.started_at, r.last_seen, r.title, r.context_model).changes > 0
            ? 'added'
            : 'present';
        break;
      case 'node':
        outcome = importNode(r.id, r.kind, r.name, r);
        break;
      case 'waypoint':
        outcome = importNode(r.id, 'conversation-waypoint', r.title, r);
        break;
      case 'edge':
        outcome = importEdge(r);
        break;
      case 'alias':
        outcome = importAlias(r);
        break;
      case 'annotation':
        outcome = importAnnotation(r);
        break;
      case 'promotion':
        outcome = importPromotion(r.node);
        break;
      case 'semantic_edge':
        outcome = importSemantic(r);
        break;
      case 'pending_edge':
        outcome = importPending(r);
        break;
      case 'orphan':
        outcome = importOrphan(r);
        break;
    }
    const c = (result.records[r.type] ??= { added: 0, present: 0, orphaned: 0, dropped: 0 });
    c[outcome]++;
  }

  // Waiting memory: a new 'import-unmatched' row per code node not found, or
  // the items added to the row already waiting for it.
  const now = Date.now();
  for (const p of parked.values()) {
    if (!p.added) continue;
    if (p.existing) {
      const e = p.existing.payload;
      const a = p.added;
      const merged: OrphanPayload = {
        ...e,
        hub_explicit: e.hub_explicit || a.hub_explicit,
        aliases: [...e.aliases, ...a.aliases],
        annotations: [...e.annotations, ...a.annotations],
        semantic_edges: [...e.semantic_edges, ...a.semantic_edges],
        pending_edges: [...e.pending_edges, ...a.pending_edges],
        edges: [...e.edges, ...a.edges],
        anchors: { ...a.anchors, ...e.anchors },
      };
      sql.waitingPayload.run(JSON.stringify(merged), p.existing.rowId);
    } else {
      const k = p.ref.key;
      sql.orphan.run(
        p.ref.id,
        k.kind,
        k.name,
        k.qualifiedName,
        k.filePath,
        JSON.stringify(p.added),
        now,
        'import-unmatched',
      );
    }
    result.orphanRows++;
  }

  for (const [id, map] of rewrites) {
    const row = sql.data.get(id) as { data: string } | null;
    if (!row) continue;
    const data = JSON.parse(row.data) as Record<string, unknown>;
    let changed = false;
    for (const field of new Set(Object.values(REF_FIELD))) {
      const list = data[field];
      if (!Array.isArray(list)) continue;
      data[field] = list.map((v) => {
        const to = typeof v === 'string' ? map.get(v) : undefined;
        if (to === undefined) return v;
        changed = true;
        return to;
      });
    }
    if (changed) sql.setData.run(JSON.stringify(data), id);
  }
  return result;
};

// Merge a memory export into the graph, in one transaction. Throws
// MemoryFileError (and writes nothing) for a file it cannot read.
export const importMemory = (db: SqliteAdapter, text: string): MemoryImportResult => {
  const records = parseMemoryFile(text);
  return db.transaction(() => runImport(db, records))();
};
