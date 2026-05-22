import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 1,
  description: 'Initial Rig schema: nodes, structural + semantic edges, embeddings, activations, FTS5',
  applied_in_phase: 1,
  forward: `
CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  pull_score REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind),
  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

CREATE TABLE IF NOT EXISTS edges_semantic (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,
  provenance TEXT NOT NULL,
  rationale TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, provenance),
  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_edges_semantic_src ON edges_semantic(src);
CREATE INDEX IF NOT EXISTS idx_edges_semantic_dst ON edges_semantic(dst);

CREATE TABLE IF NOT EXISTS embeddings (
  node_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activations (
  node_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activations_node_ts ON activations(node_id, ts);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  target_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified_name, node_id UNINDEXED
);

CREATE TRIGGER IF NOT EXISTS nodes_after_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    NEW.id
  );
END;

CREATE TRIGGER IF NOT EXISTS nodes_after_update AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    NEW.id
  );
END;

CREATE TRIGGER IF NOT EXISTS nodes_after_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
END;
  `.trim(),
  rollback: `
DROP TRIGGER IF EXISTS nodes_after_delete;
DROP TRIGGER IF EXISTS nodes_after_update;
DROP TRIGGER IF EXISTS nodes_after_insert;
DROP TABLE IF EXISTS nodes_fts;
DROP TABLE IF EXISTS unresolved_refs;
DROP TABLE IF EXISTS activations;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS edges_semantic;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS schema_versions;
  `.trim(),
});
