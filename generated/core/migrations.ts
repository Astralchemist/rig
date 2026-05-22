// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/migrations/v1.contract.ts
// Edit the .contract.ts file(s), then run `bun run gen`.

export interface Migration {
  version: number;
  description: string;
  forward: string;
  rollback: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial Rig schema: nodes, structural + semantic edges, embeddings, activations, FTS5",
    forward: "CREATE TABLE IF NOT EXISTS schema_versions (\n  version INTEGER PRIMARY KEY,\n  applied_at INTEGER NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS files (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  path TEXT NOT NULL UNIQUE,\n  mtime INTEGER NOT NULL,\n  hash TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_files_path ON files(path);\n\nCREATE TABLE IF NOT EXISTS nodes (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  name TEXT NOT NULL,\n  data TEXT NOT NULL,\n  pull_score REAL DEFAULT 0,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);\nCREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);\n\nCREATE TABLE IF NOT EXISTS edges (\n  src TEXT NOT NULL,\n  dst TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  provenance TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (src, dst, kind),\n  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,\n  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);\nCREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);\nCREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);\n\nCREATE TABLE IF NOT EXISTS edges_semantic (\n  src TEXT NOT NULL,\n  dst TEXT NOT NULL,\n  weight REAL NOT NULL,\n  provenance TEXT NOT NULL,\n  rationale TEXT,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (src, dst, provenance),\n  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,\n  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_edges_semantic_src ON edges_semantic(src);\nCREATE INDEX IF NOT EXISTS idx_edges_semantic_dst ON edges_semantic(dst);\n\nCREATE TABLE IF NOT EXISTS embeddings (\n  node_id TEXT PRIMARY KEY,\n  model TEXT NOT NULL,\n  dim INTEGER NOT NULL,\n  vector BLOB NOT NULL,\n  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE\n);\n\nCREATE TABLE IF NOT EXISTS activations (\n  node_id TEXT NOT NULL,\n  ts INTEGER NOT NULL,\n  source TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_activations_node_ts ON activations(node_id, ts);\n\nCREATE TABLE IF NOT EXISTS unresolved_refs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  src TEXT NOT NULL,\n  target_name TEXT NOT NULL,\n  file_path TEXT NOT NULL,\n  line INTEGER NOT NULL\n);\n\nCREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(\n  name, qualified_name, content=''\n);",
    rollback: "DROP TABLE IF EXISTS nodes_fts;\nDROP TABLE IF EXISTS unresolved_refs;\nDROP TABLE IF EXISTS activations;\nDROP TABLE IF EXISTS embeddings;\nDROP TABLE IF EXISTS edges_semantic;\nDROP TABLE IF EXISTS edges;\nDROP TABLE IF EXISTS nodes;\nDROP TABLE IF EXISTS files;\nDROP TABLE IF EXISTS schema_versions;",
  },
];
