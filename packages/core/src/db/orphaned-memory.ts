// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';
import { DERIVED_EDGE_PROVENANCE, EXTRACTED_KINDS } from './extracted-nodes.ts';

// orphaned_memory (v12): agent-written memory that hung off a node the update
// pipeline deleted because its symbol or file is gone. The FK cascades would
// drop it silently, so it is snapshotted first, and re-attached when a node
// with the same anchor — (file_path, kind, qualified_name) plus its ordinal
// among equal anchors — is extracted again. Cross-file moves and renames are
// not followed.
//
// Payload (JSON, `v: 1`), ids as they were when the node was deleted:
//   ordinal          position among nodes with the same anchor
//   hub_explicit     promoted via rig_promote
//   aliases          [{ alias, provenance, rationale, created_at }]
//   annotations      [{ id, note, ts, actor, rationale }]
//   semantic_edges   edges_semantic rows touching the node
//   pending_edges    pending_edges rows (any status) touching the node
//   edges            non-derived `edges` rows touching the node
//                    (waypoint_references, cluster membership, ...)
//   anchors          { [other endpoint id]: anchor } for endpoints that are
//                    extracted nodes, so one re-created under a new id is
//                    still found

export type OrphanReason = 'symbol-removed' | 'file-deleted';

export interface OrphanAnchor {
  file_path: string;
  kind: string;
  qualified_name: string;
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
      `SELECT src, dst, weight, provenance, rationale, created_at FROM edges_semantic
       WHERE src = ? OR dst = ?`,
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
  const insert = db.prepare(
    `INSERT INTO orphaned_memory
       (node_id, kind, name, qualified_name, file_path, payload, orphaned_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const anchorOf = (id: string): OrphanAnchor | null => {
    const r = q.endpoint.get(id) as { type: string; name: string; data: string } | null;
    if (!r || !EXTRACTED.has(r.type)) return null;
    const d = JSON.parse(r.data) as { filePath?: string; qualifiedName?: string };
    if (!d.filePath) return null;
    return { file_path: d.filePath, kind: r.type, qualified_name: d.qualifiedName ?? r.name };
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

// Re-attach orphaned memory to freshly written nodes whose anchor and ordinal
// match an orphan row, then drop the row. Edges come back only when their
// other endpoint exists (by id, or by anchor if it was re-created under a new
// id); the rest is dropped with the row. A re-attached waypoint_references
// edge also gets its waypoint's constellation_refs rewritten to the new id.
// Returns the number of orphan rows re-attached.
export const reattachOrphans = (db: SqliteAdapter, nodes: readonly AnchoredNode[]): number => {
  const files = new Set(
    (
      db.prepare(`SELECT DISTINCT file_path FROM orphaned_memory`).all() as { file_path: string }[]
    ).map((r) => r.file_path),
  );
  if (files.size === 0) return 0;
  const byAnchor = db.prepare(
    `SELECT id, node_id, payload FROM orphaned_memory
     WHERE file_path = ? AND kind = ? AND qualified_name = ? ORDER BY id`,
  );

  // Pass 1: pair rows with nodes, and map every old id to its new one, so
  // memory linking two re-created nodes is restored whichever comes first.
  const matches: { rowId: number; oldId: string; newId: string; payload: OrphanPayload }[] = [];
  const idMap = new Map<string, string>();
  for (const n of nodes) {
    if (!files.has(n.filePath)) continue;
    const rows = byAnchor.all(n.filePath, n.kind, n.qualifiedName) as {
      id: number;
      node_id: string;
      payload: string;
    }[];
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as OrphanPayload;
      if ((payload.ordinal ?? 0) !== n.ordinal) continue;
      matches.push({ rowId: r.id, oldId: r.node_id, newId: n.id, payload });
      idMap.set(r.node_id, n.id);
    }
  }
  if (matches.length === 0) return 0;

  const exists = db.prepare(`SELECT 1 AS x FROM nodes WHERE id = ?`);
  const byNodeAnchor = db.prepare(
    `SELECT id FROM nodes
     WHERE json_extract(data, '$.filePath') = ? AND type = ?
       AND COALESCE(json_extract(data, '$.qualifiedName'), name) = ?`,
  );
  // An endpoint with an anchor is checked against it: a deleted node's id can
  // later be generated again for a different symbol.
  const resolveEnd = (id: string, anchors: Record<string, OrphanAnchor>): string | null => {
    const mapped = idMap.get(id);
    if (mapped) return mapped;
    const a = anchors[id];
    if (!a) return exists.get(id) ? id : null;
    const hits = byNodeAnchor.all(a.file_path, a.kind, a.qualified_name) as { id: string }[];
    if (hits.some((h) => h.id === id)) return id;
    return hits.length === 1 ? hits[0]!.id : null;
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
      `INSERT OR IGNORE INTO edges_semantic (src, dst, weight, provenance, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
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
  };

  // Pass 2: attach.
  for (const { rowId, oldId, newId, payload: p } of matches) {
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
      const src = resolveEnd(e.src, p.anchors);
      const dst = resolveEnd(e.dst, p.anchors);
      if (src && dst) ins.semantic.run(src, dst, e.weight, e.provenance, e.rationale, e.created_at);
    }
    for (const e of p.pending_edges) {
      if (ins.pendingById.get(e.id)) continue;
      const src = resolveEnd(e.src, p.anchors);
      const dst = resolveEnd(e.dst, p.anchors);
      if (!src || !dst) continue;
      ins.pending.run(
        e.id,
        src,
        dst,
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
      const src = resolveEnd(e.src, p.anchors);
      const dst = resolveEnd(e.dst, p.anchors);
      if (!src || !dst) continue;
      ins.edge.run(src, dst, e.kind, e.provenance, e.created_at);
      if (e.kind === 'waypoint_references' && dst === newId && newId !== oldId) {
        const w = ins.waypoint.get(src) as { data: string } | null;
        if (w) {
          const data = JSON.parse(w.data) as { constellation_refs?: string[] };
          if (Array.isArray(data.constellation_refs)) {
            data.constellation_refs = data.constellation_refs.map((r) => (r === oldId ? newId : r));
            ins.waypointData.run(JSON.stringify(data), src);
          }
        }
      }
    }
    ins.drop.run(rowId);
  }
  return matches.length;
};
