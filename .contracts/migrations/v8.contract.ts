import { defineMigrationContract } from '@rig/contracts';

// C1 (hot-node tracking) — annotate each activation with the session that
// fired it and a hash of the query string that caused it. Lets `rig_hotspots`
// distinguish "many sessions touched this once" from "one session hammered it"
// and lets `rig_query_log`-style analytics aggregate by query hash later (C2).
export default defineMigrationContract({
  version: 8,
  description: 'C1: session_id + query_hash columns on activations',
  applied_in_phase: 4,
  forward: `
ALTER TABLE activations ADD COLUMN session_id TEXT;
ALTER TABLE activations ADD COLUMN query_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_activations_query_hash ON activations(query_hash);
CREATE INDEX IF NOT EXISTS idx_activations_session ON activations(session_id);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_activations_session;
DROP INDEX IF EXISTS idx_activations_query_hash;
-- SQLite cannot DROP COLUMN before 3.35; intentional no-op for older runtimes.
  `.trim(),
});
