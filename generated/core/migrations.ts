// GENERATED FILE — DO NOT EDIT.
// Source: .contracts/migrations/v1.contract.ts, .contracts/migrations/v2.contract.ts, .contracts/migrations/v3.contract.ts, .contracts/migrations/v4.contract.ts, .contracts/migrations/v5.contract.ts, .contracts/migrations/v6.contract.ts, .contracts/migrations/v7.contract.ts, .contracts/migrations/v8.contract.ts, .contracts/migrations/v9.contract.ts, .contracts/migrations/v10.contract.ts, .contracts/migrations/v11.contract.ts, .contracts/migrations/v12.contract.ts
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
    forward: "CREATE TABLE IF NOT EXISTS schema_versions (\n  version INTEGER PRIMARY KEY,\n  applied_at INTEGER NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS files (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  path TEXT NOT NULL UNIQUE,\n  mtime INTEGER NOT NULL,\n  hash TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_files_path ON files(path);\n\nCREATE TABLE IF NOT EXISTS nodes (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  name TEXT NOT NULL,\n  data TEXT NOT NULL,\n  pull_score REAL DEFAULT 0,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);\nCREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);\n\nCREATE TABLE IF NOT EXISTS edges (\n  src TEXT NOT NULL,\n  dst TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  provenance TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (src, dst, kind),\n  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,\n  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);\nCREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);\nCREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);\n\nCREATE TABLE IF NOT EXISTS edges_semantic (\n  src TEXT NOT NULL,\n  dst TEXT NOT NULL,\n  weight REAL NOT NULL,\n  provenance TEXT NOT NULL,\n  rationale TEXT,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (src, dst, provenance),\n  FOREIGN KEY (src) REFERENCES nodes(id) ON DELETE CASCADE,\n  FOREIGN KEY (dst) REFERENCES nodes(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_edges_semantic_src ON edges_semantic(src);\nCREATE INDEX IF NOT EXISTS idx_edges_semantic_dst ON edges_semantic(dst);\n\nCREATE TABLE IF NOT EXISTS embeddings (\n  node_id TEXT PRIMARY KEY,\n  model TEXT NOT NULL,\n  dim INTEGER NOT NULL,\n  vector BLOB NOT NULL,\n  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE\n);\n\nCREATE TABLE IF NOT EXISTS activations (\n  node_id TEXT NOT NULL,\n  ts INTEGER NOT NULL,\n  source TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_activations_node_ts ON activations(node_id, ts);\n\nCREATE TABLE IF NOT EXISTS unresolved_refs (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  src TEXT NOT NULL,\n  target_name TEXT NOT NULL,\n  file_path TEXT NOT NULL,\n  line INTEGER NOT NULL\n);\n\nCREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(\n  name, qualified_name, node_id UNINDEXED\n);\n\nCREATE TRIGGER IF NOT EXISTS nodes_after_insert AFTER INSERT ON nodes BEGIN\n  INSERT INTO nodes_fts(name, qualified_name, node_id)\n  VALUES (\n    NEW.name,\n    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),\n    NEW.id\n  );\nEND;\n\nCREATE TRIGGER IF NOT EXISTS nodes_after_update AFTER UPDATE ON nodes BEGIN\n  DELETE FROM nodes_fts WHERE node_id = OLD.id;\n  INSERT INTO nodes_fts(name, qualified_name, node_id)\n  VALUES (\n    NEW.name,\n    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),\n    NEW.id\n  );\nEND;\n\nCREATE TRIGGER IF NOT EXISTS nodes_after_delete AFTER DELETE ON nodes BEGIN\n  DELETE FROM nodes_fts WHERE node_id = OLD.id;\nEND;",
    rollback: "DROP TRIGGER IF EXISTS nodes_after_delete;\nDROP TRIGGER IF EXISTS nodes_after_update;\nDROP TRIGGER IF EXISTS nodes_after_insert;\nDROP TABLE IF EXISTS nodes_fts;\nDROP TABLE IF EXISTS unresolved_refs;\nDROP TABLE IF EXISTS activations;\nDROP TABLE IF EXISTS embeddings;\nDROP TABLE IF EXISTS edges_semantic;\nDROP TABLE IF EXISTS edges;\nDROP TABLE IF EXISTS nodes;\nDROP TABLE IF EXISTS files;\nDROP TABLE IF EXISTS schema_versions;",
  },
  {
    version: 2,
    description: "Phase 3 read-write: pending_edges, mutation_log, provenance triggers",
    forward: "CREATE TABLE IF NOT EXISTS pending_edges (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,\n  dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,\n  kind TEXT NOT NULL DEFAULT 'related',\n  weight REAL NOT NULL DEFAULT 0.5,\n  provenance TEXT NOT NULL,\n  rationale TEXT NOT NULL,\n  proposed_at INTEGER NOT NULL,\n  session_id TEXT NOT NULL,\n  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))\n);\nCREATE INDEX IF NOT EXISTS idx_pending_edges_status ON pending_edges(status);\nCREATE INDEX IF NOT EXISTS idx_pending_edges_session ON pending_edges(session_id);\n\nCREATE TABLE IF NOT EXISTS mutation_log (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ts INTEGER NOT NULL,\n  session_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  actor TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_mutation_log_session_ts ON mutation_log(session_id, ts);\nCREATE INDEX IF NOT EXISTS idx_mutation_log_ts ON mutation_log(ts);\n\nCREATE TRIGGER IF NOT EXISTS edges_provenance_nonempty\n  BEFORE INSERT ON edges\n  WHEN NEW.provenance IS NULL OR NEW.provenance = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'edges: provenance required');\n  END;\n\nCREATE TRIGGER IF NOT EXISTS edges_semantic_provenance_nonempty\n  BEFORE INSERT ON edges_semantic\n  WHEN NEW.provenance IS NULL OR NEW.provenance = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'edges_semantic: provenance required');\n  END;\n\nCREATE TRIGGER IF NOT EXISTS pending_edges_provenance_nonempty\n  BEFORE INSERT ON pending_edges\n  WHEN NEW.provenance IS NULL OR NEW.provenance = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'pending_edges: provenance required');\n  END;\n\nCREATE TRIGGER IF NOT EXISTS pending_edges_rationale_nonempty\n  BEFORE INSERT ON pending_edges\n  WHEN NEW.rationale IS NULL OR NEW.rationale = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'pending_edges: rationale required');\n  END;",
    rollback: "DROP TRIGGER IF EXISTS pending_edges_rationale_nonempty;\nDROP TRIGGER IF EXISTS pending_edges_provenance_nonempty;\nDROP TRIGGER IF EXISTS edges_semantic_provenance_nonempty;\nDROP TRIGGER IF EXISTS edges_provenance_nonempty;\nDROP TABLE IF EXISTS mutation_log;\nDROP TABLE IF EXISTS pending_edges;",
  },
  {
    version: 3,
    description: "Phase 3.5 A1: hub-and-spoke topology — is_hub + hubness on nodes",
    forward: "ALTER TABLE nodes ADD COLUMN is_hub INTEGER NOT NULL DEFAULT 0;\nALTER TABLE nodes ADD COLUMN hubness REAL NOT NULL DEFAULT 0;\nALTER TABLE nodes ADD COLUMN hub_explicit INTEGER NOT NULL DEFAULT 0;\nCREATE INDEX IF NOT EXISTS idx_nodes_is_hub ON nodes(is_hub) WHERE is_hub = 1;\nCREATE INDEX IF NOT EXISTS idx_nodes_hubness ON nodes(hubness DESC);",
    rollback: "DROP INDEX IF EXISTS idx_nodes_hubness;\nDROP INDEX IF EXISTS idx_nodes_is_hub;\n-- SQLite cannot DROP COLUMN before 3.35; rollback is destructive (table recreate).\n-- Left as a no-op for forward-only deployments.",
  },
  {
    version: 4,
    description: "Phase 3.5 A3: aliases table + FTS5 union for canonical-anchor resolution",
    forward: "CREATE TABLE IF NOT EXISTS aliases (\n  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,\n  alias TEXT NOT NULL,\n  provenance TEXT NOT NULL,\n  rationale TEXT,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (node_id, alias)\n);\nCREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);\n\nCREATE VIRTUAL TABLE IF NOT EXISTS aliases_fts USING fts5(\n  alias, node_id UNINDEXED, tokenize = 'unicode61'\n);\n\nCREATE TRIGGER IF NOT EXISTS aliases_after_insert AFTER INSERT ON aliases BEGIN\n  INSERT INTO aliases_fts(alias, node_id) VALUES (NEW.alias, NEW.node_id);\nEND;\n\nCREATE TRIGGER IF NOT EXISTS aliases_after_delete AFTER DELETE ON aliases BEGIN\n  DELETE FROM aliases_fts WHERE node_id = OLD.node_id AND alias = OLD.alias;\nEND;\n\nCREATE TRIGGER IF NOT EXISTS aliases_provenance_nonempty\n  BEFORE INSERT ON aliases\n  WHEN NEW.provenance IS NULL OR NEW.provenance = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'aliases: provenance required');\n  END;",
    rollback: "DROP TRIGGER IF EXISTS aliases_provenance_nonempty;\nDROP TRIGGER IF EXISTS aliases_after_delete;\nDROP TRIGGER IF EXISTS aliases_after_insert;\nDROP TABLE IF EXISTS aliases_fts;\nDROP INDEX IF EXISTS idx_aliases_alias;\nDROP TABLE IF EXISTS aliases;",
  },
  {
    version: 5,
    description: "A3.5 perf: text_hash on embeddings lets re-index skip unchanged nodes",
    forward: "ALTER TABLE embeddings ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';",
    rollback: "-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.",
  },
  {
    version: 6,
    description: "A4-lite: community_id column on nodes for label-propagation clustering",
    forward: "ALTER TABLE nodes ADD COLUMN community_id INTEGER NOT NULL DEFAULT 0;\nCREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);",
    rollback: "DROP INDEX IF EXISTS idx_nodes_community;\n-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.",
  },
  {
    version: 7,
    description: "Scope nodes_after_update FTS trigger to name + data columns",
    forward: "DROP TRIGGER IF EXISTS nodes_after_update;\nCREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN\n  DELETE FROM nodes_fts WHERE node_id = OLD.id;\n  INSERT INTO nodes_fts(name, qualified_name, node_id)\n  VALUES (\n    NEW.name,\n    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),\n    NEW.id\n  );\nEND;",
    rollback: "DROP TRIGGER IF EXISTS nodes_after_update;\nCREATE TRIGGER nodes_after_update AFTER UPDATE ON nodes BEGIN\n  DELETE FROM nodes_fts WHERE node_id = OLD.id;\n  INSERT INTO nodes_fts(name, qualified_name, node_id)\n  VALUES (\n    NEW.name,\n    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),\n    NEW.id\n  );\nEND;",
  },
  {
    version: 8,
    description: "C1: session_id + query_hash columns on activations",
    forward: "ALTER TABLE activations ADD COLUMN session_id TEXT;\nALTER TABLE activations ADD COLUMN query_hash TEXT;\nCREATE INDEX IF NOT EXISTS idx_activations_query_hash ON activations(query_hash);\nCREATE INDEX IF NOT EXISTS idx_activations_session ON activations(session_id);",
    rollback: "DROP INDEX IF EXISTS idx_activations_session;\nDROP INDEX IF EXISTS idx_activations_query_hash;\n-- SQLite cannot DROP COLUMN before 3.35; intentional no-op for older runtimes.",
  },
  {
    version: 9,
    description: "B1: sessions table for waypoint provenance",
    forward: "CREATE TABLE IF NOT EXISTS sessions (\n  id TEXT PRIMARY KEY,\n  started_at INTEGER NOT NULL,\n  last_seen INTEGER NOT NULL,\n  title TEXT,\n  context_model TEXT\n);\nCREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen DESC);",
    rollback: "DROP INDEX IF EXISTS idx_sessions_last_seen;\nDROP TABLE IF EXISTS sessions;",
  },
  {
    version: 10,
    description: "A2 follow-up: kind column on unresolved_refs for phantom-import detection",
    forward: "ALTER TABLE unresolved_refs ADD COLUMN kind TEXT;\nCREATE INDEX IF NOT EXISTS idx_unresolved_kind_target ON unresolved_refs(kind, target_name);",
    rollback: "DROP INDEX IF EXISTS idx_unresolved_kind_target;\n-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.",
  },
  {
    version: 11,
    description: "E1: source_urls JSON column on pending_edges",
    forward: "ALTER TABLE pending_edges ADD COLUMN source_urls TEXT;",
    rollback: "-- SQLite cannot DROP COLUMN before 3.35; intentional no-op.",
  },
  {
    version: 12,
    description: "Retention: per-file extraction artifacts, extractor_version, annotations table, orphaned_memory",
    forward: "ALTER TABLE files ADD COLUMN extractor_version INTEGER;\n\nCREATE TABLE IF NOT EXISTS file_refs (\n  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,\n  src TEXT NOT NULL,\n  target_name TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  payload TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);\n\nCREATE TABLE IF NOT EXISTS file_edges (\n  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,\n  src TEXT NOT NULL,\n  dst TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  payload TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_file_edges_path ON file_edges(path);\n\nCREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(json_extract(data, '$.filePath'));\n\nCREATE TABLE IF NOT EXISTS annotations (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,\n  note TEXT NOT NULL,\n  ts INTEGER NOT NULL,\n  actor TEXT NOT NULL,\n  rationale TEXT\n);\nCREATE INDEX IF NOT EXISTS idx_annotations_node ON annotations(node_id, ts);\n\nCREATE TRIGGER IF NOT EXISTS annotations_actor_nonempty\n  BEFORE INSERT ON annotations\n  WHEN NEW.actor IS NULL OR NEW.actor = ''\n  BEGIN\n    SELECT RAISE(ABORT, 'annotations: actor required');\n  END;\n\nINSERT INTO annotations (node_id, note, ts, actor, rationale)\nSELECT n.id,\n       COALESCE(json_extract(a.value, '$.note'), ''),\n       COALESCE(json_extract(a.value, '$.ts'), n.updated_at),\n       COALESCE(NULLIF(json_extract(a.value, '$.actor'), ''), 'unknown'),\n       json_extract(a.value, '$.rationale')\nFROM nodes n, json_each(n.data, '$.annotations') a\nWHERE json_type(n.data, '$.annotations') = 'array' AND a.type = 'object'\nORDER BY n.rowid, a.key;\n\nUPDATE nodes SET data = json_remove(data, '$.annotations')\nWHERE json_type(data, '$.annotations') = 'array';\n\nCREATE TABLE IF NOT EXISTS orphaned_memory (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  node_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  name TEXT NOT NULL,\n  qualified_name TEXT NOT NULL,\n  file_path TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  orphaned_at INTEGER NOT NULL,\n  reason TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_orphaned_memory_anchor\n  ON orphaned_memory(file_path, kind, qualified_name);",
    rollback: "DROP INDEX IF EXISTS idx_orphaned_memory_anchor;\nDROP TABLE IF EXISTS orphaned_memory;\n-- Fold annotations back into nodes.data before dropping the table.\nUPDATE nodes SET data = json_set(data, '$.annotations', (\n  SELECT json_group_array(json_object('note', a.note, 'ts', a.ts, 'actor', a.actor, 'rationale', a.rationale))\n  FROM annotations a WHERE a.node_id = nodes.id\n)) WHERE id IN (SELECT node_id FROM annotations);\nDROP TRIGGER IF EXISTS annotations_actor_nonempty;\nDROP INDEX IF EXISTS idx_annotations_node;\nDROP TABLE IF EXISTS annotations;\nDROP INDEX IF EXISTS idx_nodes_file_path;\nDROP INDEX IF EXISTS idx_file_edges_path;\nDROP TABLE IF EXISTS file_edges;\nDROP INDEX IF EXISTS idx_file_refs_path;\nDROP TABLE IF EXISTS file_refs;\n-- SQLite cannot DROP COLUMN before 3.35; files.extractor_version stays (intentional no-op).",
  },
];
