import { defineMigrationContract } from '@rig/contracts';

// Write path.
//
// - edges_semantic.kind / source_urls — accepting a proposal copied src, dst,
//   weight, provenance and rationale into edges_semantic and dropped the
//   proposed kind and the evidence URLs (v11). Rows accepted before this
//   migration take both from the accepted pending_edges row with the same
//   (src, dst, provenance), the newest if several match. Rows with no such
//   proposal keep kind 'related' (the proposal default, and what every reader
//   reported for them) and no URLs.
// - meta — key/value facts about the graph itself. The update pipeline
//   records when `rig index` and `rig sync` (or the watcher) last completed;
//   status used to report the newest activation as the last sync.
export default defineMigrationContract({
  version: 13,
  description: 'Write path: kind + source_urls on edges_semantic (backfilled), meta table',
  applied_in_phase: 4,
  forward: `
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
  `.trim(),
  rollback: `
DROP TABLE IF EXISTS meta;
-- SQLite cannot DROP COLUMN before 3.35; edges_semantic.kind / source_urls stay (intentional no-op).
  `.trim(),
});
