// SPDX-License-Identifier: Apache-2.0
import { CALLABLE_KINDS, positionOrdinals } from '../reconcile-nodes.ts';
import type { SqliteAdapter } from './adapter.ts';
import { DERIVED_EDGE_PROVENANCE, EXTRACTED_KINDS } from './extracted-nodes.ts';

// orphaned_memory (v12): agent-written memory that hung off a node the update
// pipeline deleted because its symbol or file is gone. The FK cascades would
// drop it silently, so it is snapshotted first, and re-attached when a node
// with the same anchor — (file_path, kind, qualified_name) plus its ordinal
// among equal anchors — is extracted again. Cross-file moves and renames are
// not followed.
//
// Payload (JSON, `v: 1`), ids as they were when the row was written:
//   ordinal          position among nodes with the same anchor
//   hub_explicit     promoted via rig_promote
//   aliases          [{ alias, provenance, rationale, created_at }]
//   annotations      [{ id, note, ts, actor, rationale }]
//   semantic_edges   edges_semantic rows touching the node (kind and
//                    source_urls since v13)
//   pending_edges    pending_edges rows (any status) touching the node
//   edges            non-derived `edges` rows touching the node
//                    (waypoint_references, cluster membership, ...)
//   anchors          { [other endpoint id]: anchor } for endpoints that are
//                    extracted nodes, so one re-created under a new id is
//                    still found
//
// Reasons: 'symbol-removed' and 'file-deleted' for a deleted node's own
// memory; 'endpoint-missing' for edges of a re-attached node whose other end
// is still gone — they wait in a row anchored at that end.

export type OrphanReason = 'symbol-removed' | 'file-deleted' | 'endpoint-missing';

export interface OrphanAnchor {
  file_path: string;
  kind: string;
  qualified_name: string;
  name?: string;
  ordinal?: number;
}

export interface OrphanPayload {
  v: 1;
  ordinal: number;
  hub_explicit: boolean;
  aliases: { alias: string; provenance: string; rationale: string | null; created_at: number }[];
  annotations: {
    id: number;
    note: string;
    ts: number;
    actor: string;
    rationale: string | null;
  }[];
  semantic_edges: {
    src: string;
    dst: string;
    weight: number;
    provenance: string;
    rationale: string | null;
    created_at: number;
    // v13; absent from rows snapshotted before it.
    kind?: string;
    source_urls?: string | null;
  }[];
  pending_edges: {
    id: number;
    src: string;
    dst: string;
    kind: string;
    weight: number;
    provenance: string;
    rationale: string;
    proposed_at: number;
    session_id: string;
    status: string;
    source_urls: string | null;
  }[];
  edges: { src: string; dst: string; kind: string; provenance: string; created_at: number }[];
  anchors: Record<string, OrphanAnchor>;
}

type EdgeList = 'semantic_edges' | 'pending_edges' | 'edges';

// A node about to be deleted, or a node just written, with its anchor.
export interface AnchoredNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  ordinal: number;
}

const EXTRACTED: ReadonlySet<string> = new Set(EXTRACTED_KINDS);

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

const anchorOfNode = (n: AnchoredNode): OrphanAnchor => ({
  file_path: n.filePath,
  kind: n.kind,
  qualified_name: n.qualifiedName,
  name: n.name,
  ordinal: n.ordinal,
});

// Ids of the nodes holding an anchor, in ordinal (position) order.
const nodesAtAnchor = (db: SqliteAdapter) => {
  const q = db.prepare(
    `SELECT id, data FROM nodes
     WHERE json_extract(data, '$.filePath') = ? AND type = ?
       AND COALESCE(json_extract(data, '$.qualifiedName'), name) = ?`,
  );
  return (filePath: string, kind: string, qualifiedName: string): string[] => {
    const rows = (q.all(filePath, kind, qualifiedName) as { id: string; data: string }[]).map(
      (r) => {
        const d = JSON.parse(r.data) as { startLine?: number; startColumn?: number };
        return {
          id: r.id,
          kind,
          qualifiedName,
          startLine: d.startLine ?? 0,
          startColumn: d.startColumn ?? 0,
        };
      },
    );
    const ordinals = positionOrdinals(rows);
    const out: string[] = [];
    rows.forEach((r, i) => (out[ordinals[i]!] = r.id));
    return out;
  };
};

const insertOrphanSql = `INSERT INTO orphaned_memory
  (node_id, kind, name, qualified_name, file_path, payload, orphaned_at, reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export const countOrphans = (db: SqliteAdapter): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM orphaned_memory`).get() as { n: number }).n;

// Snapshot the memory of nodes that are about to be deleted. Call for the
// whole batch before deleting any of it, so memory linking two deleted nodes
// lands in both rows. Returns the number of orphan rows written.
export const snapshotOrphans = (
  db: SqliteAdapter,
  nodes: readonly (AnchoredNode & { reason: OrphanReason })[],
): number => {
  if (nodes.length === 0) return 0;
  const q = {
    hub: db.prepare(`SELECT hub_explicit FROM nodes WHERE id = ?`),
    aliases: db.prepare(
      `SELECT alias, provenance, rationale, created_at FROM aliases WHERE node_id = ? ORDER BY created_at`,
    ),
    annotations: db.prepare(
      `SELECT id, note, ts, actor, rationale FROM annotations WHERE node_id = ? ORDER BY ts, id`,
    ),
    semantic: db.prepare(
      `SELECT src, dst, weight, provenance, rationale, created_at, kind, source_urls
       FROM edges_semantic WHERE src = ? OR dst = ?`,
    ),
    pending: db.prepare(
      `SELECT id, src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status,
              source_urls
       FROM pending_edges WHERE src = ? OR dst = ? ORDER BY id`,
    ),
    edges: db.prepare(
      `SELECT src, dst, kind, provenance, created_at FROM edges
       WHERE (src = ? OR dst = ?) AND provenance != ?`,
    ),
    endpoint: db.prepare(`SELECT type, name, data FROM nodes WHERE id = ?`),
  };
  const insert = db.prepare(insertOrphanSql);
  const atAnchor = nodesAtAnchor(db);
  const anchorOf = (id: string): OrphanAnchor | null => {
    const r = q.endpoint.get(id) as { type: string; name: string; data: string } | null;
    if (!r || !EXTRACTED.has(r.type)) return null;
    const d = JSON.parse(r.data) as { filePath?: string; qualifiedName?: string };
    if (!d.filePath) return null;
    const qualifiedName = d.qualifiedName ?? r.name;
    const ordinal = atAnchor(d.filePath, r.type, qualifiedName).indexOf(id);
    return {
      file_path: d.filePath,
      kind: r.type,
      qualified_name: qualifiedName,
      name: r.name,
      ordinal: Math.max(ordinal, 0),
    };
  };

  const now = Date.now();
  let written = 0;
  for (const n of nodes) {
    const hub = q.hub.get(n.id) as { hub_explicit: number } | null;
    const payload: OrphanPayload = {
      v: 1,
      ordinal: n.ordinal,
      hub_explicit: hub?.hub_explicit === 1,
      aliases: q.aliases.all(n.id) as OrphanPayload['aliases'],
      annotations: q.annotations.all(n.id) as OrphanPayload['annotations'],
      semantic_edges: q.semantic.all(n.id, n.id) as OrphanPayload['semantic_edges'],
      pending_edges: q.pending.all(n.id, n.id) as OrphanPayload['pending_edges'],
      edges: q.edges.all(n.id, n.id, DERIVED_EDGE_PROVENANCE) as OrphanPayload['edges'],
      anchors: {},
    };
    const empty =
      !payload.hub_explicit &&
      payload.aliases.length === 0 &&
      payload.annotations.length === 0 &&
      payload.semantic_edges.length === 0 &&
      payload.pending_edges.length === 0 &&
      payload.edges.length === 0;
    if (empty) continue;
    for (const e of [...payload.semantic_edges, ...payload.pending_edges, ...payload.edges]) {
      for (const end of [e.src, e.dst]) {
        if (end === n.id || end in payload.anchors) continue;
        const a = anchorOf(end);
        if (a) payload.anchors[end] = a;
      }
    }
    insert.run(
      n.id,
      n.kind,
      n.name,
      n.qualifiedName,
      n.filePath,
      JSON.stringify(payload),
      now,
      n.reason,
    );
    written++;
  }
  return written;
};

interface Match {
  rowId: number;
  oldId: string;
  node: AnchoredNode;
  orphanedAt: number;
  payload: OrphanPayload;
}

// Re-attach orphaned memory to freshly written nodes whose anchor and ordinal
// match an orphan row, then drop the row. As a last resort, a callable whose
// kind changed (function <-> method, e.g. a Python def an older extractor
// typed `method`) matches a leftover row on qualified_name + ordinal. An edge
// comes back once its other endpoint exists; until then it waits in an
// 'endpoint-missing' row anchored at that endpoint (an agent-written endpoint
// that is gone is gone for good). A re-attached waypoint_references edge also
// gets its waypoint's constellation_refs rewritten to the new id. Returns the
// number of orphan rows re-attached.
export const reattachOrphans = (db: SqliteAdapter, nodes: readonly AnchoredNode[]): number => {
  const files = new Set(
    (
      db.prepare(`SELECT DISTINCT file_path FROM orphaned_memory`).all() as { file_path: string }[]
    ).map((r) => r.file_path),
  );
  if (files.size === 0) return 0;
  const byAnchor = db.prepare(
    `SELECT id, node_id, payload, orphaned_at FROM orphaned_memory
     WHERE file_path = ? AND kind = ? AND qualified_name = ? ORDER BY id`,
  );

  // Pass 1: pair rows with nodes, and map every old id to its new one, so
  // memory linking two re-created nodes is restored whichever comes first.
  const matches: Match[] = [];
  const idMap = new Map<string, string>();
  const usedRows = new Set<number>();
  const matchedNodes = new Set<string>();
  const pair = (n: AnchoredNode, kind: string): void => {
    const rows = byAnchor.all(n.filePath, kind, n.qualifiedName) as {
      id: number;
      node_id: string;
      payload: string;
      orphaned_at: number;
    }[];
    for (const r of rows) {
      if (usedRows.has(r.id)) continue;
      const payload = JSON.parse(r.payload) as OrphanPayload;
      if ((payload.ordinal ?? 0) !== n.ordinal) continue;
      matches.push({ rowId: r.id, oldId: r.node_id, node: n, orphanedAt: r.orphaned_at, payload });
      idMap.set(r.node_id, n.id);
      usedRows.add(r.id);
      matchedNodes.add(n.id);
    }
  };
  const candidates = nodes.filter((n) => files.has(n.filePath));
  for (const n of candidates) pair(n, n.kind);
  // Last resort, among the leftovers: the callable kind it used to have.
  for (const n of candidates) {
    if (matchedNodes.has(n.id) || !CALLABLE_KINDS.has(n.kind)) continue;
    for (const kind of CALLABLE_KINDS) if (kind !== n.kind) pair(n, kind);
  }
  if (matches.length === 0) return 0;

  const created = db.prepare(`SELECT created_at FROM nodes WHERE id = ?`);
  const atAnchor = nodesAtAnchor(db);
  // Where an endpoint of the memory is now, or null while it is gone.
  const resolveEnd = (id: string, m: Match): string | null => {
    const mapped = idMap.get(id);
    if (mapped) return mapped;
    const row = created.get(id) as { created_at: number } | null;
    const a = m.payload.anchors[id];
    // Still the row the memory pointed at: it predates the orphaning, and an
    // id is never handed to another node while a row holds it. Its anchor may
    // have changed in place since (a dependency's spec, a renamed class).
    if (row && (!a || row.created_at <= m.orphanedAt)) return id;
    if (!a) return null;
    // Re-created since: find it by anchor and ordinal (a deleted node's id can
    // later be generated again for a different symbol).
    const hits = atAnchor(a.file_path, a.kind, a.qualified_name);
    if (hits.includes(id)) return id;
    return hits[a.ordinal ?? 0] ?? null;
  };

  // Edges whose other endpoint is still gone, grouped by that endpoint.
  const waiting = new Map<string, { anchor: OrphanAnchor; payload: OrphanPayload }>();
  // Resolve both ends of an edge; when one is missing, park the edge (the end
  // that did resolve rewritten) on the missing end's anchor and return null.
  const place = <T extends { src: string; dst: string }>(
    item: T,
    list: EdgeList,
    m: Match,
  ): { src: string; dst: string } | null => {
    const src = resolveEnd(item.src, m);
    const dst = resolveEnd(item.dst, m);
    if (src && dst) return { src, dst };
    const missing = src ? item.dst : item.src;
    const anchor = m.payload.anchors[missing];
    if (!anchor) return null;
    let entry = waiting.get(missing);
    if (!entry) {
      entry = { anchor, payload: emptyPayload(anchor.ordinal ?? 0) };
      waiting.set(missing, entry);
    }
    (entry.payload[list] as unknown[]).push({
      ...item,
      src: src ?? item.src,
      dst: dst ?? item.dst,
    });
    entry.payload.anchors[m.node.id] = anchorOfNode(m.node);
    return null;
  };

  const ins = {
    alias: db.prepare(
      `INSERT OR IGNORE INTO aliases (node_id, alias, provenance, rationale, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    annotationById: db.prepare(`SELECT 1 AS x FROM annotations WHERE id = ?`),
    annotation: db.prepare(
      `INSERT INTO annotations (id, node_id, note, ts, actor, rationale) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    promote: db.prepare(
      `UPDATE nodes SET hub_explicit = 1, is_hub = 1, hubness = MAX(hubness, 0.3) WHERE id = ?`,
    ),
    semantic: db.prepare(
      `INSERT OR IGNORE INTO edges_semantic
         (src, dst, weight, provenance, rationale, created_at, kind, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    pendingById: db.prepare(`SELECT 1 AS x FROM pending_edges WHERE id = ?`),
    pending: db.prepare(
      `INSERT INTO pending_edges
         (id, src, dst, kind, weight, provenance, rationale, proposed_at, session_id, status, source_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    edge: db.prepare(
      `INSERT OR IGNORE INTO edges (src, dst, kind, provenance, created_at) VALUES (?, ?, ?, ?, ?)`,
    ),
    waypoint: db.prepare(`SELECT data FROM nodes WHERE id = ? AND type = 'conversation-waypoint'`),
    waypointData: db.prepare(`UPDATE nodes SET data = ? WHERE id = ?`),
    drop: db.prepare(`DELETE FROM orphaned_memory WHERE id = ?`),
    orphan: db.prepare(insertOrphanSql),
  };

  // Pass 2: attach.
  for (const m of matches) {
    const { oldId, payload: p } = m;
    const newId = m.node.id;
    for (const a of p.aliases) {
      ins.alias.run(newId, a.alias, a.provenance, a.rationale, a.created_at);
    }
    for (const a of p.annotations) {
      // Keep the original id (mutation_log refers to it); once it is back,
      // a second copy of the payload is a no-op.
      if (ins.annotationById.get(a.id)) continue;
      ins.annotation.run(a.id, newId, a.note, a.ts, a.actor, a.rationale);
    }
    if (p.hub_explicit) ins.promote.run(newId);
    for (const e of p.semantic_edges) {
      const ends = place(e, 'semantic_edges', m);
      if (ends) {
        ins.semantic.run(
          ends.src,
          ends.dst,
          e.weight,
          e.provenance,
          e.rationale,
          e.created_at,
          e.kind ?? 'related',
          e.source_urls ?? null,
        );
      }
    }
    for (const e of p.pending_edges) {
      if (ins.pendingById.get(e.id)) continue;
      const ends = place(e, 'pending_edges', m);
      if (!ends) continue;
      ins.pending.run(
        e.id,
        ends.src,
        ends.dst,
        e.kind,
        e.weight,
        e.provenance,
        e.rationale,
        e.proposed_at,
        e.session_id,
        e.status,
        e.source_urls,
      );
    }
    for (const e of p.edges) {
      const ends = place(e, 'edges', m);
      if (!ends) continue;
      ins.edge.run(ends.src, ends.dst, e.kind, e.provenance, e.created_at);
      if (e.kind === 'waypoint_references' && ends.dst === newId && newId !== oldId) {
        const w = ins.waypoint.get(ends.src) as { data: string } | null;
        if (w) {
          const data = JSON.parse(w.data) as { constellation_refs?: string[] };
          if (Array.isArray(data.constellation_refs)) {
            data.constellation_refs = data.constellation_refs.map((r) => (r === oldId ? newId : r));
            ins.waypointData.run(JSON.stringify(data), ends.src);
          }
        }
      }
    }
    ins.drop.run(m.rowId);
  }

  const now = Date.now();
  for (const [missing, { anchor, payload }] of waiting) {
    ins.orphan.run(
      missing,
      anchor.kind,
      anchor.name ?? anchor.qualified_name,
      anchor.qualified_name,
      anchor.file_path,
      JSON.stringify(payload),
      now,
      'endpoint-missing',
    );
  }
  return matches.length;
};
