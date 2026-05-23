-- GENERATED FILE — DO NOT EDIT.
-- Source: .contracts/migrations/v1.contract.ts, .contracts/migrations/v2.contract.ts, .contracts/migrations/v3.contract.ts, .contracts/migrations/v4.contract.ts, .contracts/migrations/v5.contract.ts, .contracts/migrations/v6.contract.ts
-- Edit the .contract.ts file(s), then run `bun run gen`.

-- v1: Initial Rig schema: nodes, structural + semantic edges, embeddings, activations, FTS5
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

-- v2: Phase 3 read-write: pending_edges, mutation_log, provenance triggers
CREATE TABLE IF NOT EXISTS pending_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'related',
  weight REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_pending_edges_status ON pending_edges(status);
CREATE INDEX IF NOT EXISTS idx_pending_edges_session ON pending_edges(session_id);

CREATE TABLE IF NOT EXISTS mutation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutation_log_session_ts ON mutation_log(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_mutation_log_ts ON mutation_log(ts);

CREATE TRIGGER IF NOT EXISTS edges_provenance_nonempty
  BEFORE INSERT ON edges
  WHEN NEW.provenance IS NULL OR NEW.provenance = ''
  BEGIN
    SELECT RAISE(ABORT, 'edges: provenance required');
  END;

CREATE TRIGGER IF NOT EXISTS edges_semantic_provenance_nonempty
  BEFORE INSERT ON edges_semantic
  WHEN NEW.provenance IS NULL OR NEW.provenance = ''
  BEGIN
    SELECT RAISE(ABORT, 'edges_semantic: provenance required');
  END;

CREATE TRIGGER IF NOT EXISTS pending_edges_provenance_nonempty
  BEFORE INSERT ON pending_edges
  WHEN NEW.provenance IS NULL OR NEW.provenance = ''
  BEGIN
    SELECT RAISE(ABORT, 'pending_edges: provenance required');
  END;

CREATE TRIGGER IF NOT EXISTS pending_edges_rationale_nonempty
  BEFORE INSERT ON pending_edges
  WHEN NEW.rationale IS NULL OR NEW.rationale = ''
  BEGIN
    SELECT RAISE(ABORT, 'pending_edges: rationale required');
  END;

-- v3: Phase 3.5 A1: hub-and-spoke topology — is_hub + hubness on nodes
ALTER TABLE nodes ADD COLUMN is_hub INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN hubness REAL NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN hub_explicit INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_is_hub ON nodes(is_hub) WHERE is_hub = 1;
CREATE INDEX IF NOT EXISTS idx_nodes_hubness ON nodes(hubness DESC);

-- v4: Phase 3.5 A3: aliases table + FTS5 union for canonical-anchor resolution
CREATE TABLE IF NOT EXISTS aliases (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  provenance TEXT NOT NULL,
  rationale TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

CREATE VIRTUAL TABLE IF NOT EXISTS aliases_fts USING fts5(
  alias, node_id UNINDEXED, tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS aliases_after_insert AFTER INSERT ON aliases BEGIN
  INSERT INTO aliases_fts(alias, node_id) VALUES (NEW.alias, NEW.node_id);
END;

CREATE TRIGGER IF NOT EXISTS aliases_after_delete AFTER DELETE ON aliases BEGIN
  DELETE FROM aliases_fts WHERE node_id = OLD.node_id AND alias = OLD.alias;
END;

CREATE TRIGGER IF NOT EXISTS aliases_provenance_nonempty
  BEFORE INSERT ON aliases
  WHEN NEW.provenance IS NULL OR NEW.provenance = ''
  BEGIN
    SELECT RAISE(ABORT, 'aliases: provenance required');
  END;

-- v5: A3.5 perf: text_hash on embeddings lets re-index skip unchanged nodes
ALTER TABLE embeddings ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';

-- v6: A4-lite: community_id column on nodes for label-propagation clustering
ALTER TABLE nodes ADD COLUMN community_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);
