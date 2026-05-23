import { defineMigrationContract } from '@rig/contracts';

export default defineMigrationContract({
  version: 3,
  description: 'Phase 3.5 A1: hub-and-spoke topology — is_hub + hubness on nodes',
  applied_in_phase: 4,
  forward: `
ALTER TABLE nodes ADD COLUMN is_hub INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN hubness REAL NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN hub_explicit INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_is_hub ON nodes(is_hub) WHERE is_hub = 1;
CREATE INDEX IF NOT EXISTS idx_nodes_hubness ON nodes(hubness DESC);
  `.trim(),
  rollback: `
DROP INDEX IF EXISTS idx_nodes_hubness;
DROP INDEX IF EXISTS idx_nodes_is_hub;
-- SQLite cannot DROP COLUMN before 3.35; rollback is destructive (table recreate).
-- Left as a no-op for forward-only deployments.
  `.trim(),
});
