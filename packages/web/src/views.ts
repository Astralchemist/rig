// SPDX-License-Identifier: Apache-2.0
import type { Rig } from '@rig/core';
import type { SqliteAdapter } from '@rig/core/db/adapter.ts';
import { parseSourceUrls } from '@rig/core/db/pending-edges.ts';

// Read-only view models for the map's focused views. Each one answers a
// screen in a single request (a neighbourhood with its node cards, an impact
// tree, the orphan list) so the UI never fans out one fetch per node.

// What a node card shows: identity, where it lives, and the badges.
export interface NodeCard {
  id: string;
  kind: string;
  name: string;
  file: string | null;
  line: number | null;
  signature: string | null;
  is_hub: boolean;
  hubness: number;
  annotations: number;
  waypoints: number;
  // Orphaned memory waiting in this node's file for its symbol to return.
  orphans: number;
}

export interface ViewEdge {
  src: string;
  dst: string;
  kind: string;
  table: 'structural' | 'semantic' | 'pending';
  weight?: number;
  source_urls?: string[];
  pending_id?: number;
}

interface CardRow {
  id: string;
  type: string;
  name: string;
  data: string;
  is_hub: number;
  hubness: number;
  annotations: number;
  waypoints: number;
}

const CARD_SQL = `SELECT n.id, n.type, n.name, n.data, n.is_hub, n.hubness,
    (SELECT COUNT(*) FROM annotations a WHERE a.node_id = n.id) AS annotations,
    (SELECT COUNT(*) FROM edges w WHERE w.dst = n.id AND w.kind = 'waypoint_references') AS waypoints
  FROM nodes n WHERE n.id IN `;

const placeholders = (n: number): string => `(${Array.from({ length: n }, () => '?').join(',')})`;

// SQLite caps bound parameters; stay well under it.
const CHUNK = 400;

const orphanCountsByFile = (db: SqliteAdapter, files: string[]): Map<string, number> => {
  const out = new Map<string, number>();
  if (files.length === 0) return out;
  for (let i = 0; i < files.length; i += CHUNK) {
    const part = files.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT file_path, COUNT(*) AS n FROM orphaned_memory WHERE file_path IN ${placeholders(part.length)} GROUP BY file_path`,
      )
      .all(...part) as { file_path: string; n: number }[];
    for (const r of rows) out.set(r.file_path, r.n);
  }
  return out;
};

export const nodeCards = (rig: Rig, ids: readonly string[]): NodeCard[] => {
  const db = rig.database.adapter;
  const unique = [...new Set(ids)];
  const rows: CardRow[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    rows.push(...(db.prepare(CARD_SQL + placeholders(part.length)).all(...part) as CardRow[]));
  }
  const parsed = rows.map((r) => {
    let d: { filePath?: unknown; startLine?: unknown; signature?: unknown } = {};
    try {
      d = JSON.parse(r.data) as typeof d;
    } catch {
      // keep the card without location
    }
    return { r, d };
  });
  const files = parsed.map(({ d }) => d.filePath).filter((f): f is string => typeof f === 'string');
  const orphans = orphanCountsByFile(db, [...new Set(files)]);
  const byId = new Map<string, NodeCard>();
  for (const { r, d } of parsed) {
    const file = typeof d.filePath === 'string' && d.filePath ? d.filePath : null;
    byId.set(r.id, {
      id: r.id,
      kind: r.type,
      name: r.name,
      file,
      line: typeof d.startLine === 'number' ? d.startLine : null,
      signature: typeof d.signature === 'string' ? d.signature : null,
      is_hub: r.is_hub === 1,
      hubness: r.hubness ?? 0,
      annotations: r.annotations,
      waypoints: r.waypoints,
      orphans: file ? (orphans.get(file) ?? 0) : 0,
    });
  }
  // Input order, unknown ids dropped.
  return unique.map((id) => byId.get(id)).filter((c): c is NodeCard => c !== undefined);
};

export interface Neighborhood {
  center: NodeCard;
  nodes: NodeCard[];
  edges: ViewEdge[];
  // Neighbours left out by the limit.
  truncated: number;
}

// One hop around a node: every structural, accepted and pending edge, with
// cards for both ends. Hubs and annotated nodes are kept first when the
// limit cuts.
export const neighborhood = (rig: Rig, id: string, limit = 40): Neighborhood | null => {
  const db = rig.database.adapter;
  const center = nodeCards(rig, [id])[0];
  if (!center) return null;
  const edges: ViewEdge[] = [];
  const struct = db
    .prepare(`SELECT src, dst, kind FROM edges WHERE src = ? OR dst = ? LIMIT 500`)
    .all(id, id) as { src: string; dst: string; kind: string }[];
  for (const e of struct) edges.push({ ...e, table: 'structural' });
  const sem = db
    .prepare(
      `SELECT src, dst, kind, weight, source_urls FROM edges_semantic WHERE src = ? OR dst = ? LIMIT 200`,
    )
    .all(id, id) as {
    src: string;
    dst: string;
    kind: string;
    weight: number;
    source_urls: string | null;
  }[];
  for (const e of sem) {
    edges.push({
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      weight: e.weight,
      table: 'semantic',
      source_urls: parseSourceUrls(e.source_urls),
    });
  }
  const pend = db
    .prepare(
      `SELECT id, src, dst, kind, weight, source_urls FROM pending_edges WHERE status = 'pending' AND (src = ? OR dst = ?)`,
    )
    .all(id, id) as {
    id: number;
    src: string;
    dst: string;
    kind: string;
    weight: number;
    source_urls: string | null;
  }[];
  for (const e of pend) {
    edges.push({
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      weight: e.weight,
      table: 'pending',
      pending_id: e.id,
      source_urls: parseSourceUrls(e.source_urls),
    });
  }
  const others = [...new Set(edges.map((e) => (e.src === id ? e.dst : e.src)))].filter(
    (o) => o !== id,
  );
  const cards = nodeCards(rig, others);
  // Memory first (pending, accepted), then hubs, then the rest.
  const rank = (c: NodeCard): number => {
    const es = edges.filter((e) => e.src === c.id || e.dst === c.id);
    const mem = es.some((e) => e.table !== 'structural') ? 2 : 0;
    return mem + c.hubness + (c.annotations > 0 ? 0.5 : 0);
  };
  cards.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  const kept = cards.slice(0, limit);
  const keep = new Set([id, ...kept.map((c) => c.id)]);
  return {
    center,
    nodes: kept,
    edges: edges.filter((e) => keep.has(e.src) && keep.has(e.dst)),
    truncated: Math.max(0, cards.length - kept.length),
  };
};

export interface ImpactTree {
  root: NodeCard;
  nodes: (NodeCard & { depth: number })[];
  // parent → child, where the child depends on the parent through `kind`.
  edges: { src: string; dst: string; kind: string }[];
  truncated: boolean;
}

// What depends on a node, as a tree: breadth-first over incoming structural
// edges (the same reach rig_impact walks), each node attached to the first
// parent that reached it. Capped so the view stays readable.
export const impactTree = (rig: Rig, id: string, depth = 3, cap = 120): ImpactTree | null => {
  const db = rig.database.adapter;
  const root = nodeCards(rig, [id])[0];
  if (!root) return null;
  const incoming = db.prepare(
    `SELECT src, kind FROM edges WHERE dst = ? AND kind NOT IN ('waypoint_references', 'waypoint_succeeds') ORDER BY kind, src`,
  );
  const seen = new Map<string, number>([[id, 0]]);
  const edges: ImpactTree['edges'] = [];
  let frontier = [id];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const r of incoming.all(parent) as { src: string; kind: string }[]) {
        if (seen.has(r.src)) continue;
        if (seen.size > cap) {
          truncated = true;
          break;
        }
        seen.set(r.src, d);
        edges.push({ src: parent, dst: r.src, kind: r.kind });
        next.push(r.src);
      }
    }
    frontier = next;
  }
  const cards = nodeCards(
    rig,
    [...seen.keys()].filter((k) => k !== id),
  );
  return {
    root,
    nodes: cards.map((c) => ({ ...c, depth: seen.get(c.id) ?? 0 })),
    edges,
    truncated,
  };
};

export interface OrphanRow {
  id: number;
  node_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  reason: string;
  orphaned_at: number;
  // What is waiting: counts by memory type.
  memory: { annotations: number; aliases: number; edges: number; pending_edges: number };
  notes: string[];
}

export const listOrphans = (rig: Rig, limit = 100): OrphanRow[] => {
  const rows = rig.database.adapter
    .prepare(
      `SELECT id, node_id, kind, name, qualified_name, file_path, reason, orphaned_at, payload
       FROM orphaned_memory ORDER BY orphaned_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as (Omit<OrphanRow, 'memory' | 'notes'> & { payload: string })[];
  return rows.map(({ payload, ...r }) => {
    let p: {
      annotations?: { note: string }[];
      aliases?: unknown[];
      semantic_edges?: unknown[];
      edges?: unknown[];
      pending_edges?: unknown[];
    } = {};
    try {
      p = JSON.parse(payload) as typeof p;
    } catch {
      // unreadable payload: list the row with zero counts
    }
    return {
      ...r,
      memory: {
        annotations: p.annotations?.length ?? 0,
        aliases: p.aliases?.length ?? 0,
        edges: (p.semantic_edges?.length ?? 0) + (p.edges?.length ?? 0),
        pending_edges: p.pending_edges?.length ?? 0,
      },
      notes: (p.annotations ?? []).map((a) => a.note).slice(0, 5),
    };
  });
};
