import type { SqliteAdapter } from './adapter.ts';

export interface GraphSnapshotNode {
  id: string;
  type: string;
  name: string;
  pull_score: number;
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
}

export interface GraphSnapshot {
  nodes: GraphSnapshotNode[];
  edges_structural: GraphSnapshotEdge[];
  edges_semantic: GraphSnapshotSemanticEdge[];
}

export const getGraphSnapshot = (db: SqliteAdapter, limit = 500): GraphSnapshot => {
  const nodes = db
    .prepare(
      `SELECT id, type, name, pull_score FROM nodes ORDER BY pull_score DESC, name LIMIT ?`,
    )
    .all(limit) as GraphSnapshotNode[];
  if (nodes.length === 0) {
    return { nodes: [], edges_structural: [], edges_semantic: [] };
  }
  const ids = new Set(nodes.map((n) => n.id));
  const placeholders = nodes.map(() => '?').join(',');
  const structRows = db
    .prepare(
      `SELECT src, dst, kind FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders})`,
    )
    .all(...nodes.map((n) => n.id), ...nodes.map((n) => n.id)) as GraphSnapshotEdge[];
  const semRows = db
    .prepare(
      `SELECT src, dst, weight FROM edges_semantic WHERE src IN (${placeholders}) AND dst IN (${placeholders})`,
    )
    .all(...nodes.map((n) => n.id), ...nodes.map((n) => n.id)) as GraphSnapshotSemanticEdge[];
  return {
    nodes,
    edges_structural: structRows.filter((e) => ids.has(e.src) && ids.has(e.dst)),
    edges_semantic: semRows.filter((e) => ids.has(e.src) && ids.has(e.dst)),
  };
};
