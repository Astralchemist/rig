// SPDX-License-Identifier: Apache-2.0
import type { SqliteAdapter } from './adapter.ts';
import { parseSourceUrls } from './pending-edges.ts';

export interface GraphSnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
  is_hub: number;
  hubness: number;
  community_id: number;
  // The file the node lives in; null for nodes without one (waypoints,
  // skills, dependencies). Added for the map's list view and hover cards.
  file_path: string | null;
}

export interface GraphSnapshotEdge {
  src: string;
  dst: string;
  kind: string;
}

export interface GraphSnapshotSemanticEdge {
  src: string;
  dst: string;
  weight: number;
  kind: string;
  source_urls: string[];
}

export interface GraphSnapshotPendingEdge {
  id: number;
  src: string;
  dst: string;
  kind: string;
  weight: number;
  rationale: string;
  provenance: string;
}

export interface GraphSnapshot {
  nodes: GraphSnapshotNode[];
  edges_structural: GraphSnapshotEdge[];
  edges_semantic: GraphSnapshotSemanticEdge[];
  pending_edges: GraphSnapshotPendingEdge[];
}

export const getGraphSnapshot = (db: SqliteAdapter, limit = 500): GraphSnapshot => {
  const nodes = db
    .prepare(
      `SELECT id, type, name, pull_score, is_hub, hubness, community_id,
         json_extract(data, '$.filePath') AS file_path
       FROM nodes ORDER BY hubness DESC, pull_score DESC, name LIMIT ?`,
    )
    .all(limit) as GraphSnapshotNode[];
  if (nodes.length === 0) {
    return { nodes: [], edges_structural: [], edges_semantic: [], pending_edges: [] };
  }
  const ids = new Set(nodes.map((n) => n.id));
  const placeholders = nodes.map(() => '?').join(',');
  const structRows = db
    .prepare(
      `SELECT src, dst, kind FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders})`,
    )
    .all(...nodes.map((n) => n.id), ...nodes.map((n) => n.id)) as GraphSnapshotEdge[];
  const semRows = (
    db
      .prepare(
        `SELECT src, dst, weight, kind, source_urls FROM edges_semantic WHERE src IN (${placeholders}) AND dst IN (${placeholders})`,
      )
      .all(...nodes.map((n) => n.id), ...nodes.map((n) => n.id)) as (Omit<
      GraphSnapshotSemanticEdge,
      'source_urls'
    > & { source_urls: string | null })[]
  ).map((e) => ({ ...e, source_urls: parseSourceUrls(e.source_urls) }));
  const pendingRows = db
    .prepare(
      `SELECT id, src, dst, kind, weight, rationale, provenance FROM pending_edges WHERE status = 'pending'`,
    )
    .all() as GraphSnapshotPendingEdge[];
  return {
    nodes,
    edges_structural: structRows.filter((e) => ids.has(e.src) && ids.has(e.dst)),
    edges_semantic: semRows.filter((e) => ids.has(e.src) && ids.has(e.dst)),
    pending_edges: pendingRows.filter((e) => ids.has(e.src) && ids.has(e.dst)),
  };
};
