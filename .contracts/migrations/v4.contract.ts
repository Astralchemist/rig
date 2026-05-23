import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 4,
  description: 'Phase 3.5 A3: aliases table + FTS5 union for canonical-anchor resolution',
  applied_in_phase: 4,
  forward: `
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
  `.trim(),
  rollback: `
DROP TRIGGER IF EXISTS aliases_provenance_nonempty;
DROP TRIGGER IF EXISTS aliases_after_delete;
DROP TRIGGER IF EXISTS aliases_after_insert;
DROP TABLE IF EXISTS aliases_fts;
DROP INDEX IF EXISTS idx_aliases_alias;
DROP TABLE IF EXISTS aliases;
  `.trim(),
});
