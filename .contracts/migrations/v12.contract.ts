import { defineMigrationContract } from '@rig/contracts';

// Retention. Re-index used to purge every node of a re-extracted file and
// re-insert it, and the FK cascades took all agent-written memory with it
// (aliases, promotes, pending + accepted edges, waypoint refs, annotations).
// The update pipeline now updates nodes in place; this migration adds what it
// needs:
//
// - files.extractor_version — a file is skipped only when its content hash AND
//   the extractor version that produced its rows both match. NULL marks a
//   pre-v12 row, so every existing file is re-extracted once after upgrade.
// - file_refs / file_edges — each file's last extraction output (unresolved
//   references + direct edges), keyed by path and cascaded with the files row.
//   All provenance='ast' edges are rebuilt from the artifacts of every file, so
//   `index --include`, `sync` and skipped files can never drop another file's
//   edges.
// - idx_nodes_file_path — per-file node lookups during in-place updates.
// - annotations — rig_annotate notes move out of nodes.data (which extraction
//   rewrites) into their own table. Existing data.annotations arrays are copied
//   over and removed from data.
// - orphaned_memory — when a node that carries agent-written memory really is
//   deleted (its symbol or file is gone), the memory is snapshotted here first
//   (payload JSON) and re-attached if a node with the same
//   (file_path, kind, qualified_name) comes back.
export default defineMigrationContract({
  version: 12,
  description:
    'Retention: per-file extraction artifacts, extractor_version, annotations table, orphaned_memory',
  applied_in_phase: 4,
  forward: `
ALTER TABLE files ADD COLUMN extractor_version INTEGER;

CREATE TABLE IF NOT EXISTS file_refs (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  src TEXT NOT NULL,
  target_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);

CREATE TABLE IF NOT EXISTS file_edges (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL
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
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_orphaned_memory_anchor;
DROP TABLE IF EXISTS orphaned_memory;
-- Fold annotations back into nodes.data before dropping the table.
UPDATE nodes SET data = json_set(data, '$.annotations', (
  SELECT json_group_array(json_object('note', a.note, 'ts', a.ts, 'actor', a.actor, 'rationale', a.rationale))
  FROM annotations a WHERE a.node_id = nodes.id
)) WHERE id IN (SELECT node_id FROM annotations);
DROP TRIGGER IF EXISTS annotations_actor_nonempty;
DROP INDEX IF EXISTS idx_annotations_node;
DROP TABLE IF EXISTS annotations;
DROP INDEX IF EXISTS idx_nodes_file_path;
DROP INDEX IF EXISTS idx_file_edges_path;
DROP TABLE IF EXISTS file_edges;
DROP INDEX IF EXISTS idx_file_refs_path;
DROP TABLE IF EXISTS file_refs;
-- SQLite cannot DROP COLUMN before 3.35; files.extractor_version stays (intentional no-op).
  `.trim(),
});
