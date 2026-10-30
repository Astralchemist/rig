-- GENERATED FILE — DO NOT EDIT.
-- Source: .contracts/migrations/v1.contract.ts, .contracts/migrations/v2.contract.ts, .contracts/migrations/v3.contract.ts, .contracts/migrations/v4.contract.ts, .contracts/migrations/v5.contract.ts, .contracts/migrations/v6.contract.ts, .contracts/migrations/v7.contract.ts, .contracts/migrations/v8.contract.ts, .contracts/migrations/v9.contract.ts, .contracts/migrations/v10.contract.ts, .contracts/migrations/v11.contract.ts, .contracts/migrations/v12.contract.ts, .contracts/migrations/v13.contract.ts, .contracts/migrations/v14.contract.ts, .contracts/migrations/v15.contract.ts
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

-- v7: Scope nodes_after_update FTS trigger to name + data columns
DROP TRIGGER IF EXISTS nodes_after_update;
CREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    NEW.id
  );
END;

-- v8: C1: session_id + query_hash columns on activations
ALTER TABLE activations ADD COLUMN session_id TEXT;
ALTER TABLE activations ADD COLUMN query_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_activations_query_hash ON activations(query_hash);
CREATE INDEX IF NOT EXISTS idx_activations_session ON activations(session_id);

-- v9: B1: sessions table for waypoint provenance
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  title TEXT,
  context_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen DESC);

-- v10: A2 follow-up: kind column on unresolved_refs for phantom-import detection
ALTER TABLE unresolved_refs ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_unresolved_kind_target ON unresolved_refs(kind, target_name);

-- v11: E1: source_urls JSON column on pending_edges
ALTER TABLE pending_edges ADD COLUMN source_urls TEXT;

-- v12: Retention: per-file extraction artifacts, extractor_version, annotations table, orphaned_memory
ALTER TABLE files ADD COLUMN extractor_version INTEGER;

CREATE TABLE IF NOT EXISTS file_refs (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  src TEXT NOT NULL,
  target_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);

CREATE TABLE IF NOT EXISTS file_edges (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_edges_path ON file_edges(path);

CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(json_extract(data, '$.filePath'));

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT
);
CREATE INDEX IF NOT EXISTS idx_annotations_node ON annotations(node_id, ts);

CREATE TRIGGER IF NOT EXISTS annotations_actor_nonempty
  BEFORE INSERT ON annotations
  WHEN NEW.actor IS NULL OR NEW.actor = ''
  BEGIN
    SELECT RAISE(ABORT, 'annotations: actor required');
  END;

INSERT INTO annotations (node_id, note, ts, actor, rationale)
SELECT n.id,
       COALESCE(json_extract(a.value, '$.note'), ''),
       COALESCE(json_extract(a.value, '$.ts'), n.updated_at),
       COALESCE(NULLIF(json_extract(a.value, '$.actor'), ''), 'unknown'),
       json_extract(a.value, '$.rationale')
FROM nodes n, json_each(n.data, '$.annotations') a
WHERE json_type(n.data, '$.annotations') = 'array' AND a.type = 'object'
ORDER BY n.rowid, a.key;

UPDATE nodes SET data = json_remove(data, '$.annotations')
WHERE json_type(data, '$.annotations') = 'array';

CREATE TABLE IF NOT EXISTS orphaned_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  payload TEXT NOT NULL,
  orphaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orphaned_memory_anchor
  ON orphaned_memory(file_path, kind, qualified_name);

-- v13: Write path: kind + source_urls on edges_semantic (backfilled), meta table
ALTER TABLE edges_semantic ADD COLUMN kind TEXT NOT NULL DEFAULT 'related';
ALTER TABLE edges_semantic ADD COLUMN source_urls TEXT;

UPDATE edges_semantic
SET kind = (
      SELECT p.kind FROM pending_edges p
      WHERE p.src = edges_semantic.src AND p.dst = edges_semantic.dst
        AND p.provenance = edges_semantic.provenance AND p.status = 'accepted'
      ORDER BY p.id DESC LIMIT 1
    ),
    source_urls = (
      SELECT p.source_urls FROM pending_edges p
      WHERE p.src = edges_semantic.src AND p.dst = edges_semantic.dst
        AND p.provenance = edges_semantic.provenance AND p.status = 'accepted'
      ORDER BY p.id DESC LIMIT 1
    )
WHERE EXISTS (
  SELECT 1 FROM pending_edges p
  WHERE p.src = edges_semantic.src AND p.dst = edges_semantic.dst
    AND p.provenance = edges_semantic.provenance AND p.status = 'accepted'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v14: Hybrid search: nodes_fts with tokens/signature/docstring/text columns, embeddings.seq
DROP TRIGGER IF EXISTS nodes_after_insert;
DROP TRIGGER IF EXISTS nodes_after_update;
DROP TRIGGER IF EXISTS nodes_after_delete;
DROP TABLE IF EXISTS nodes_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qualified_name, tokens, signature, docstring, text, node_id UNINDEXED
);

CREATE TRIGGER nodes_after_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(name, qualified_name, tokens, signature, docstring, text, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s.x, 'N', ' N'), 'O', ' O'), 'P', ' P'), 'Q', ' Q'), 'R', ' R'), 'S', ' S'), 'T', ' T'), 'U', ' U'), 'V', ' V'), 'W', ' W'), 'X', ' X'), 'Y', ' Y'), 'Z', ' Z') FROM (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(NEW.name || ' ' || COALESCE(json_extract(NEW.data, '$.qualifiedName'), ''), 'A', ' A'), 'B', ' B'), 'C', ' C'), 'D', ' D'), 'E', ' E'), 'F', ' F'), 'G', ' G'), 'H', ' H'), 'I', ' I'), 'J', ' J'), 'K', ' K'), 'L', ' L'), 'M', ' M') AS x) AS s),
    COALESCE(json_extract(NEW.data, '$.signature'), ''),
    COALESCE(json_extract(NEW.data, '$.docstring'), json_extract(NEW.data, '$.description'), ''),
    trim(
      COALESCE(json_extract(NEW.data, '$.summary'), '') || ' ' ||
      COALESCE(json_extract(NEW.data, '$.rationale'), '') || ' ' ||
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.key_terms')), '') || ' ' ||
      COALESCE(json_extract(NEW.data, '$.excerpt'), '')
    ),
    NEW.id
  );
END;

CREATE TRIGGER nodes_after_update AFTER UPDATE OF name, data ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
  INSERT INTO nodes_fts(name, qualified_name, tokens, signature, docstring, text, node_id)
  VALUES (
    NEW.name,
    COALESCE(json_extract(NEW.data, '$.qualifiedName'), NEW.name),
    (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s.x, 'N', ' N'), 'O', ' O'), 'P', ' P'), 'Q', ' Q'), 'R', ' R'), 'S', ' S'), 'T', ' T'), 'U', ' U'), 'V', ' V'), 'W', ' W'), 'X', ' X'), 'Y', ' Y'), 'Z', ' Z') FROM (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(NEW.name || ' ' || COALESCE(json_extract(NEW.data, '$.qualifiedName'), ''), 'A', ' A'), 'B', ' B'), 'C', ' C'), 'D', ' D'), 'E', ' E'), 'F', ' F'), 'G', ' G'), 'H', ' H'), 'I', ' I'), 'J', ' J'), 'K', ' K'), 'L', ' L'), 'M', ' M') AS x) AS s),
    COALESCE(json_extract(NEW.data, '$.signature'), ''),
    COALESCE(json_extract(NEW.data, '$.docstring'), json_extract(NEW.data, '$.description'), ''),
    trim(
      COALESCE(json_extract(NEW.data, '$.summary'), '') || ' ' ||
      COALESCE(json_extract(NEW.data, '$.rationale'), '') || ' ' ||
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.key_terms')), '') || ' ' ||
      COALESCE(json_extract(NEW.data, '$.excerpt'), '')
    ),
    NEW.id
  );
END;

CREATE TRIGGER nodes_after_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = OLD.id;
END;

INSERT INTO nodes_fts(name, qualified_name, tokens, signature, docstring, text, node_id)
SELECT 
    n.name,
    COALESCE(json_extract(n.data, '$.qualifiedName'), n.name),
    (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(s.x, 'N', ' N'), 'O', ' O'), 'P', ' P'), 'Q', ' Q'), 'R', ' R'), 'S', ' S'), 'T', ' T'), 'U', ' U'), 'V', ' V'), 'W', ' W'), 'X', ' X'), 'Y', ' Y'), 'Z', ' Z') FROM (SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(n.name || ' ' || COALESCE(json_extract(n.data, '$.qualifiedName'), ''), 'A', ' A'), 'B', ' B'), 'C', ' C'), 'D', ' D'), 'E', ' E'), 'F', ' F'), 'G', ' G'), 'H', ' H'), 'I', ' I'), 'J', ' J'), 'K', ' K'), 'L', ' L'), 'M', ' M') AS x) AS s),
    COALESCE(json_extract(n.data, '$.signature'), ''),
    COALESCE(json_extract(n.data, '$.docstring'), json_extract(n.data, '$.description'), ''),
    trim(
      COALESCE(json_extract(n.data, '$.summary'), '') || ' ' ||
      COALESCE(json_extract(n.data, '$.rationale'), '') || ' ' ||
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(n.data, '$.key_terms')), '') || ' ' ||
      COALESCE(json_extract(n.data, '$.excerpt'), '')
    ),
    n.id
FROM nodes n;

ALTER TABLE embeddings ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_embeddings_model_seq ON embeddings(model, seq);

-- v15: C5: session_clients — the agent behind each MCP session
CREATE TABLE IF NOT EXISTS session_clients (
  session_id TEXT PRIMARY KEY,
  client TEXT,
  client_label TEXT,
  started_at INTEGER NOT NULL
);
