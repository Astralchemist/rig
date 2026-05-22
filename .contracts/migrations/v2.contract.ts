import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 2,
  description: 'Phase 3 read-write: pending_edges, mutation_log, provenance triggers',
  applied_in_phase: 3,
  forward: `
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
  `.trim(),
  rollback: `
DROP TRIGGER IF EXISTS pending_edges_rationale_nonempty;
DROP TRIGGER IF EXISTS pending_edges_provenance_nonempty;
DROP TRIGGER IF EXISTS edges_semantic_provenance_nonempty;
DROP TRIGGER IF EXISTS edges_provenance_nonempty;
DROP TABLE IF EXISTS mutation_log;
DROP TABLE IF EXISTS pending_edges;
  `.trim(),
});
