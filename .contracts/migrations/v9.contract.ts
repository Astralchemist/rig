import { defineMigrationContract } from '@rig/contracts';

// B1 (conversation waypoints) — discrete decision/observation markers the AI
// drops during a session. Waypoints themselves live in the existing nodes
// table as type='conversation-waypoint'; this migration only adds the
// per-session metadata table so a fresh session can locate "the last
// session's waypoints" without scanning all of mutation_log.
export default defineMigrationContract({
  version: 9,
  description: 'B1: sessions table for waypoint provenance',
  applied_in_phase: 4,
  forward: `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  title TEXT,
  context_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen DESC);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_sessions_last_seen;
DROP TABLE IF EXISTS sessions;
  `.trim(),
});
